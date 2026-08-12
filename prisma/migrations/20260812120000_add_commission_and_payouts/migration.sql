-- Module 8 · Commission & Payouts.
--
-- The second module that moves real money and the larger of the two. Module 7
-- takes money from customers in amounts they agreed to; this one sends money
-- out, in amounts nobody outside the system can check, to people who depend on
-- it. Every choice below leans toward visible and recoverable.
--
-- `booking_commissions` and `commission_payouts` already exist and already
-- carry every ERD column, so most of this is additive: four new tables and a
-- handful of columns that the ERD does not name but the behaviour requires.
--
-- Additive only. Nothing existing changes type, nothing needs backfilling: no
-- commission row has ever been written, so every new NOT NULL column on those
-- two tables either has a default or is nullable.

-- ---------------------------------------------------------------------
-- booking_commissions · approval and reversal
-- ---------------------------------------------------------------------
-- `status` gains two more states. `pending` is what completion writes;
-- `approved` is what the hold window grants and the only state a payout may
-- sweep (US-8.9 — a disputed job under review must not be batched and then
-- reversed). `reversed` is terminal.
--
-- A reversed row that was already `paid` KEEPS `paid`. It was paid. The
-- recovery is a `payout_deductions` row, never a bank debit (US-8.14).

ALTER TABLE "booking_commissions"
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversalReason" TEXT,
  ADD COLUMN "reversedByAdminId" UUID;

ALTER TABLE "booking_commissions"
  ADD CONSTRAINT "booking_commissions_status_check"
    CHECK ("status" IN ('pending', 'approved', 'paid', 'reversed'));

ALTER TABLE "booking_commissions"
  ADD CONSTRAINT "booking_commissions_commissionType_check"
    CHECK ("commissionType" IN ('percent', 'flat'));

-- The two shares provably sum to what the customer paid. Enforced here rather
-- than trusted to the calculator, because this is the invariant every report,
-- reconciliation and dispute rests on.
ALTER TABLE "booking_commissions"
  ADD CONSTRAINT "booking_commissions_shares_sum_check"
    CHECK ("commissionAmount" + "platformAmount" = "customerFlatAmount");

ALTER TABLE "booking_commissions"
  ADD CONSTRAINT "booking_commissions_nonnegative_check"
    CHECK (
      "commissionAmount" >= 0 AND "platformAmount" >= 0
      AND "incentiveAmount" >= 0 AND "deductionAmount" >= 0
    );

ALTER TABLE "booking_commissions"
  ADD CONSTRAINT "booking_commissions_reversedByAdminId_fkey"
    FOREIGN KEY ("reversedByAdminId") REFERENCES "admin_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The batching query: approved, unpaid, this Pro, oldest first.
CREATE INDEX "booking_commissions_status_proId_computedAt_idx"
  ON "booking_commissions"("status", "proId", "computedAt");

-- ---------------------------------------------------------------------
-- commission_payouts · disbursement
-- ---------------------------------------------------------------------
-- `idempotencyKey` is unique here as well as at RazorpayX, so a double-submit
-- cannot become a double payment even on a request that never reaches them.
--
-- A retry mints a NEW key on purpose: reusing one makes RazorpayX replay the
-- original response instead of attempting the transfer again, which is the
-- opposite of what a retry is for.

ALTER TABLE "commission_payouts"
  ADD COLUMN "disbursedByAdminId" UUID,
  ADD COLUMN "disbursedAt" TIMESTAMP(3),
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "payoutMode" TEXT,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failureReason" TEXT;

ALTER TABLE "commission_payouts"
  ADD CONSTRAINT "commission_payouts_status_check"
    CHECK ("status" IN ('draft', 'approved', 'processing', 'paid', 'failed', 'rejected'));

ALTER TABLE "commission_payouts"
  ADD CONSTRAINT "commission_payouts_payoutMode_check"
    CHECK ("payoutMode" IS NULL OR "payoutMode" IN ('vpa', 'bank_account'));

-- A payout is never negative. Deductions are consumed only up to what was
-- earned; the remainder waits for the next period.
ALTER TABLE "commission_payouts"
  ADD CONSTRAINT "commission_payouts_netAmount_check"
    CHECK ("netAmount" >= 0);

ALTER TABLE "commission_payouts"
  ADD CONSTRAINT "commission_payouts_period_check"
    CHECK ("periodEnd" >= "periodStart");

ALTER TABLE "commission_payouts"
  ADD CONSTRAINT "commission_payouts_disbursedByAdminId_fkey"
    FOREIGN KEY ("disbursedByAdminId") REFERENCES "admin_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "commission_payouts_idempotencyKey_key"
  ON "commission_payouts"("idempotencyKey");

CREATE INDEX "commission_payouts_status_periodEnd_idx"
  ON "commission_payouts"("status", "periodEnd");

-- ---------------------------------------------------------------------
-- pros / pro_bank_accounts · the payable destination
-- ---------------------------------------------------------------------
-- `accountNumberMasked` is exactly that, and a masked number cannot be paid
-- to. RazorpayX wants a Contact (the person) and a Fund Account (the
-- instrument), created once and referenced by id forever.
--
-- Module 8 can create a VPA fund account today, because `upiId` is the one
-- instrument stored here in full. A bank fund account can only be created
-- while the unmasked number is in hand — module 2's verification step. This
-- column is the seam for it, and until it is filled, bank payouts fail with a
-- sentence naming the Pro rather than a gateway error.
-- See CONFLICTS_AND_DECISIONS #51.

ALTER TABLE "pros"
  ADD COLUMN "razorpayxContactId" TEXT;

ALTER TABLE "pro_bank_accounts"
  ADD COLUMN "razorpayxFundAccountId" TEXT,
  ADD COLUMN "razorpayxFundAccountType" TEXT;

ALTER TABLE "pro_bank_accounts"
  ADD CONSTRAINT "pro_bank_accounts_razorpayxFundAccountType_check"
    CHECK (
      "razorpayxFundAccountType" IS NULL
      OR "razorpayxFundAccountType" IN ('vpa', 'bank_account')
    );

-- ---------------------------------------------------------------------
-- incentives
-- ---------------------------------------------------------------------
-- Four types are named; two have evaluators. `streak` and `surge_slot` are
-- accepted so a scheme can be configured, and every read reports
-- `hasEvaluator: false` for them. The failure a Pro must never hit is a bonus
-- advertised in the app that silently never pays.
--
-- `recurrence` is the dimension that makes "complete 20 jobs -> Rs 2,000" a
-- monthly promise rather than a once-ever one. Progress is keyed by the period
-- it yields.

CREATE TABLE "incentives" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "incentiveType" TEXT NOT NULL,
  "recurrence" TEXT NOT NULL DEFAULT 'once',
  "criteriaJson" JSONB NOT NULL,
  "rewardAmount" DECIMAL(12,2) NOT NULL,
  "cityId" UUID,
  "validFrom" TIMESTAMP(3) NOT NULL,
  "validTo" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdByAdminId" UUID,

  CONSTRAINT "incentives_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "incentives"
  ADD CONSTRAINT "incentives_incentiveType_check"
    CHECK ("incentiveType" IN ('jobs_count', 'rating', 'streak', 'surge_slot'));

ALTER TABLE "incentives"
  ADD CONSTRAINT "incentives_recurrence_check"
    CHECK ("recurrence" IN ('once', 'daily', 'weekly', 'monthly'));

ALTER TABLE "incentives"
  ADD CONSTRAINT "incentives_rewardAmount_check" CHECK ("rewardAmount" >= 0);

ALTER TABLE "incentives"
  ADD CONSTRAINT "incentives_validity_check"
    CHECK ("validTo" IS NULL OR "validTo" > "validFrom");

ALTER TABLE "incentives"
  ADD CONSTRAINT "incentives_cityId_fkey" FOREIGN KEY ("cityId")
    REFERENCES "cities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "incentives"
  ADD CONSTRAINT "incentives_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId")
    REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "incentives_isActive_validFrom_validTo_idx"
  ON "incentives"("isActive", "validFrom", "validTo");
CREATE INDEX "incentives_cityId_isActive_idx"
  ON "incentives"("cityId", "isActive");

-- ---------------------------------------------------------------------
-- pro_incentive_progress
-- ---------------------------------------------------------------------
-- Unique on (pro, incentive, periodKey) rather than (pro, incentive). Without
-- the period a recurring scheme is permanently locked by its first row and can
-- only ever be won once, whatever `recurrence` says.

CREATE TABLE "pro_incentive_progress" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "proId" UUID NOT NULL,
  "incentiveId" UUID NOT NULL,
  "periodKey" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "progressValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "targetValue" DECIMAL(12,2) NOT NULL,
  "achievedAt" TIMESTAMP(3),
  "rewardCredited" BOOLEAN NOT NULL DEFAULT false,
  "rewardAmount" DECIMAL(12,2),
  "commissionId" UUID,

  CONSTRAINT "pro_incentive_progress_pkey" PRIMARY KEY ("id")
);

-- A credited reward must record both what it paid and which job it was paid
-- against, or a reversal has nothing to follow back.
ALTER TABLE "pro_incentive_progress"
  ADD CONSTRAINT "pro_incentive_progress_credited_check"
    CHECK (
      "rewardCredited" = false
      OR ("rewardAmount" IS NOT NULL AND "commissionId" IS NOT NULL AND "achievedAt" IS NOT NULL)
    );

ALTER TABLE "pro_incentive_progress"
  ADD CONSTRAINT "pro_incentive_progress_proId_fkey" FOREIGN KEY ("proId")
    REFERENCES "pros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pro_incentive_progress"
  ADD CONSTRAINT "pro_incentive_progress_incentiveId_fkey" FOREIGN KEY ("incentiveId")
    REFERENCES "incentives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pro_incentive_progress"
  ADD CONSTRAINT "pro_incentive_progress_commissionId_fkey" FOREIGN KEY ("commissionId")
    REFERENCES "booking_commissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "pro_incentive_progress_proId_incentiveId_periodKey_key"
  ON "pro_incentive_progress"("proId", "incentiveId", "periodKey");
CREATE INDEX "pro_incentive_progress_proId_achievedAt_idx"
  ON "pro_incentive_progress"("proId", "achievedAt");

-- ---------------------------------------------------------------------
-- pro_incentive_contributions
-- ---------------------------------------------------------------------
-- Which job contributed how much toward which run.
--
-- Progress could have stayed a bare number with a single `commissionId` for
-- whichever job tipped it over. That records the trigger and forgets the other
-- forty-nine, so reversing any of them has nothing to follow and the progress
-- silently keeps a job it no longer has. These rows are the real history:
-- progress is their sum, and unwinding one is a delete plus a recount.

CREATE TABLE "pro_incentive_contributions" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "progressId" UUID NOT NULL,
  "commissionId" UUID NOT NULL,
  "value" DECIMAL(12,2) NOT NULL,

  CONSTRAINT "pro_incentive_contributions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "pro_incentive_contributions"
  ADD CONSTRAINT "pro_incentive_contributions_progressId_fkey" FOREIGN KEY ("progressId")
    REFERENCES "pro_incentive_progress"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pro_incentive_contributions"
  ADD CONSTRAINT "pro_incentive_contributions_commissionId_fkey" FOREIGN KEY ("commissionId")
    REFERENCES "booking_commissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One contribution per job per run: the guard against a retried completion
-- counting the same job twice toward the same bonus.
CREATE UNIQUE INDEX "pro_incentive_contributions_progressId_commissionId_key"
  ON "pro_incentive_contributions"("progressId", "commissionId");
CREATE INDEX "pro_incentive_contributions_commissionId_idx"
  ON "pro_incentive_contributions"("commissionId");

-- ---------------------------------------------------------------------
-- payout_deductions
-- ---------------------------------------------------------------------
-- Money owed back to the platform, carried to the next payout. A ROW, not a
-- running total on the Pro: a scalar cannot say what the money was for, would
-- double-apply on a retry, and would be unauditable.
--
-- `dedupeKey` is the exactly-once guard for the automatic kinds. Null for a
-- manual deduction, because Postgres treats NULLs as distinct and ops may
-- legitimately raise two against the same job. This one unique column is what
-- makes "the same reversal cannot deduct twice" a database guarantee.

CREATE TABLE "payout_deductions" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "proId" UUID NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "consumedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "kind" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "sourceCommissionId" UUID,
  "dedupeKey" TEXT,
  "consumedByPayoutId" UUID,
  "fullyConsumedAt" TIMESTAMP(3),
  "waivedAt" TIMESTAMP(3),
  "waiveReason" TEXT,
  "waivedByAdminId" UUID,
  "raisedByAdminId" UUID,

  CONSTRAINT "payout_deductions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payout_deductions"
  ADD CONSTRAINT "payout_deductions_kind_check"
    CHECK ("kind" IN ('commission_reversal', 'incentive_unwind', 'manual'));

ALTER TABLE "payout_deductions"
  ADD CONSTRAINT "payout_deductions_amount_check" CHECK ("amount" > 0);

-- Consumption is partial by design, and bounded. Taking more than was owed
-- would be a silent overcharge with no row to point at.
ALTER TABLE "payout_deductions"
  ADD CONSTRAINT "payout_deductions_consumed_check"
    CHECK ("consumedAmount" >= 0 AND "consumedAmount" <= "amount");

ALTER TABLE "payout_deductions"
  ADD CONSTRAINT "payout_deductions_proId_fkey" FOREIGN KEY ("proId")
    REFERENCES "pros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payout_deductions"
  ADD CONSTRAINT "payout_deductions_sourceCommissionId_fkey" FOREIGN KEY ("sourceCommissionId")
    REFERENCES "booking_commissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payout_deductions"
  ADD CONSTRAINT "payout_deductions_consumedByPayoutId_fkey" FOREIGN KEY ("consumedByPayoutId")
    REFERENCES "commission_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payout_deductions"
  ADD CONSTRAINT "payout_deductions_waivedByAdminId_fkey" FOREIGN KEY ("waivedByAdminId")
    REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payout_deductions"
  ADD CONSTRAINT "payout_deductions_raisedByAdminId_fkey" FOREIGN KEY ("raisedByAdminId")
    REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "payout_deductions_dedupeKey_key"
  ON "payout_deductions"("dedupeKey");
CREATE INDEX "payout_deductions_proId_outstanding_idx"
  ON "payout_deductions"("proId", "fullyConsumedAt", "waivedAt");

-- ---------------------------------------------------------------------
-- Tunables
-- ---------------------------------------------------------------------
-- No magic numbers: every number this module leans on is a row an operator can
-- read and change without a deploy.
--
-- On `payout.periodDays` = 30. Every comparable Indian app settles weekly
-- because gig workers need the cash flow. Homingo's Pros are salaried
-- employees and this is the variable top-up on that salary, so monthly —
-- landing beside payroll — is one credit to reconcile instead of four.

INSERT INTO "platform_settings" ("id", "key", "value", "description", "updatedAt")
VALUES
  (
    gen_random_uuid(),
    'payout.periodDays',
    '30',
    'Length of a payout batch period in days. Monthly by default, to land beside the external payroll credit rather than scattered across it.',
    CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid(),
    'payout.minimumNetAmount',
    '0',
    'Net below which a payout rolls into the next period instead of being transferred. Zero means always pay.',
    CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid(),
    'commission.autoApproveAfterHours',
    '24',
    'How long a computed commission waits before it may be batched. The window in which a dispute or refund can still reverse it cheaply.',
    CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid(),
    'commission.sweeperLookbackHours',
    '48',
    'How far back the safety net looks for completed jobs that never got a commission row.',
    CURRENT_TIMESTAMP
  )
ON CONFLICT DO NOTHING;
