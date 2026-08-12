-- Module 9 · Ledger & Reconciliation.
--
-- The books. Everything financial lands here and nothing here is ever edited —
-- which is enforced below by a trigger, not by convention.
--
-- Three tables. No existing column changes and nothing to backfill: the ledger
-- starts empty and is rebuildable from `orders`, `bookings`, `cash_handovers`,
-- `booking_commissions` and `commission_payouts`, which is exactly what
-- reconciliation checks.

-- ---------------------------------------------------------------------
-- ledger_entries
-- ---------------------------------------------------------------------
-- ONE ROW, TWO LEGS. `debitAccount` and `creditAccount` both live on the row,
-- as the ERD models it, so every entry is balanced by construction — there is
-- no way to write half of one. An account's balance is
-- `sum(credits) - sum(debits)` over this table.
--
-- `sequence` is gap-free and is assigned under the same advisory lock that
-- reads the previous hash. Deliberately NOT a Postgres sequence: `nextval` is
-- non-transactional, so a rolled-back insert leaves a hole, and a hole in a
-- hash chain cannot be told apart from a deletion.

CREATE TABLE "ledger_entries" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sequence" BIGINT NOT NULL,
  "entryDate" TIMESTAMP(3) NOT NULL,
  "txnType" TEXT NOT NULL,
  "debitAccount" TEXT NOT NULL,
  "creditAccount" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "bookingId" UUID,
  "orderId" UUID,
  "payoutId" UUID,
  "proId" UUID,
  "customerId" UUID,
  "razorpayPaymentId" TEXT,
  "sourceRef" TEXT NOT NULL,
  "prevHash" TEXT NOT NULL,
  "entryHash" TEXT NOT NULL,

  CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_txnType_check"
    CHECK ("txnType" IN (
      'charge', 'refund', 'platform_revenue',
      'pro_commission', 'deduction', 'incentive'
    ));

-- A zero-amount entry records nothing and would still extend the chain.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_check" CHECK ("amount" > 0);

-- An entry from an account to itself is a typo, not a transaction.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_distinct_legs_check"
    CHECK ("debitAccount" <> "creditAccount");

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_sequence_check" CHECK ("sequence" > 0);

-- Restrict everywhere, on purpose. A booking with ledger entries against it is
-- a booking that moved money; deleting it must fail loudly. Restrict also means
-- no cascade ever tries to UPDATE or DELETE this table, which the trigger
-- below would refuse anyway — as a foreign-key error nobody could interpret.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_bookingId_fkey" FOREIGN KEY ("bookingId")
    REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_payoutId_fkey" FOREIGN KEY ("payoutId")
    REFERENCES "commission_payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_proId_fkey" FOREIGN KEY ("proId")
    REFERENCES "pros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_customerId_fkey" FOREIGN KEY ("customerId")
    REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ledger_entries_sequence_key" ON "ledger_entries"("sequence");
CREATE UNIQUE INDEX "ledger_entries_sourceRef_key" ON "ledger_entries"("sourceRef");
CREATE UNIQUE INDEX "ledger_entries_entryHash_key" ON "ledger_entries"("entryHash");
CREATE INDEX "ledger_entries_entryDate_idx" ON "ledger_entries"("entryDate");
CREATE INDEX "ledger_entries_debitAccount_entryDate_idx"
  ON "ledger_entries"("debitAccount", "entryDate");
CREATE INDEX "ledger_entries_creditAccount_entryDate_idx"
  ON "ledger_entries"("creditAccount", "entryDate");
CREATE INDEX "ledger_entries_proId_entryDate_idx"
  ON "ledger_entries"("proId", "entryDate");

-- ---------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------
-- A RULE ... DO INSTEAD NOTHING was the obvious alternative and is the wrong
-- one: it makes an UPDATE silently succeed while changing nothing, which is the
-- exact shape of bug this table exists to prevent. A trigger that raises turns
-- the same mistake into a stack trace with a table name in it.
--
-- This also means Prisma's `update` and `delete` on this model fail loudly if
-- anybody ever writes one, which is the point.

CREATE OR REPLACE FUNCTION "ledger_entries_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only: % is not permitted (sequence %)',
    TG_OP, COALESCE(OLD."sequence", -1);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_no_update"
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_immutable"();

CREATE TRIGGER "ledger_entries_no_delete"
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_immutable"();

-- ---------------------------------------------------------------------
-- reconciliation_runs
-- ---------------------------------------------------------------------
-- Module 7 already computes the reconciliation answer and throws it away. The
-- answer was always recomputable; what could not be recovered was the history
-- of having asked, and "when did we last check" is most of what an auditor
-- wants to know.

CREATE TABLE "reconciliation_runs" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "runDate" DATE NOT NULL,
  "scope" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'running',
  "failureReason" TEXT,
  "entriesScanned" INTEGER NOT NULL DEFAULT 0,
  "bookingsScanned" INTEGER NOT NULL DEFAULT 0,
  "ordersScanned" INTEGER NOT NULL DEFAULT 0,
  "countersRebuilt" BOOLEAN NOT NULL DEFAULT false,
  "discrepancyCount" INTEGER NOT NULL DEFAULT 0,
  "totalVarianceAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,

  CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "reconciliation_runs"
  ADD CONSTRAINT "reconciliation_runs_scope_check"
    CHECK ("scope" IN ('money', 'cash', 'ledger', 'both', 'all'));

ALTER TABLE "reconciliation_runs"
  ADD CONSTRAINT "reconciliation_runs_status_check"
    CHECK ("status" IN ('running', 'completed', 'failed'));

CREATE INDEX "reconciliation_runs_runDate_idx" ON "reconciliation_runs"("runDate");
CREATE INDEX "reconciliation_runs_status_startedAt_idx"
  ON "reconciliation_runs"("status", "startedAt");

-- ---------------------------------------------------------------------
-- reconciliation_discrepancies
-- ---------------------------------------------------------------------
-- A question for a human. NOTHING is auto-corrected: making our row match the
-- gateway's would destroy the only evidence that they ever differed.

CREATE TABLE "reconciliation_discrepancies" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "runId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "ours" TEXT,
  "theirs" TEXT,
  "variance" TEXT,
  "detail" TEXT NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNotes" TEXT,
  "resolvedByAdminId" UUID,

  CONSTRAINT "reconciliation_discrepancies_pkey" PRIMARY KEY ("id")
);

-- Deliberately NOT a CHECK on `kind`. The list grows every time a new class of
-- mismatch is discovered, and a migration to record a new *finding* would make
-- adding one expensive enough to discourage it.

ALTER TABLE "reconciliation_discrepancies"
  ADD CONSTRAINT "reconciliation_discrepancies_resolution_check"
    CHECK (("resolvedAt" IS NULL) = ("resolvedByAdminId" IS NULL));

ALTER TABLE "reconciliation_discrepancies"
  ADD CONSTRAINT "reconciliation_discrepancies_runId_fkey" FOREIGN KEY ("runId")
    REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reconciliation_discrepancies"
  ADD CONSTRAINT "reconciliation_discrepancies_resolvedByAdminId_fkey"
    FOREIGN KEY ("resolvedByAdminId") REFERENCES "admin_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The open-work query. Unresolved first, so a repeat finding on tonight's run
-- does not bury yesterday's unanswered one.
CREATE INDEX "reconciliation_discrepancies_resolvedAt_kind_idx"
  ON "reconciliation_discrepancies"("resolvedAt", "kind");
CREATE INDEX "reconciliation_discrepancies_runId_idx"
  ON "reconciliation_discrepancies"("runId");
