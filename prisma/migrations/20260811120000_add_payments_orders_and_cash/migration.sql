-- Module 7 · Payments.
--
-- Two modes, and only one of them has a gateway. Everything below divides on
-- that line:
--
--   online -> `orders`, which mirrors just enough of Razorpay to join and
--             reconcile on. Attempt history stays at the gateway.
--   cash   -> columns on `bookings` plus `pros.cashInHand` and
--             `cash_handovers`. No order row exists, ever.
--
-- ERD v10 defines `Order` and nothing else here: `cashCollectedAmount`,
-- `cashCollectedAt`, `Pro.cashInHand` and the handover table are named by the
-- module 7 feature list but absent from the ERD. They are added deliberately —
-- see CONFLICTS_AND_DECISIONS #35. Without them the cash mode has no store of
-- record at all.
--
-- Additive only. No existing column changes and nothing to backfill: every
-- booking predating this migration is cash, uncollected, which is exactly what
-- the new NULL columns say.

-- ---------------------------------------------------------------------
-- Online · orders
-- ---------------------------------------------------------------------

CREATE TABLE "orders" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "bookingId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "razorpayOrderId" TEXT NOT NULL,
  "receipt" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "amountPaid" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "amountDue" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" TEXT NOT NULL DEFAULT 'created',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failureCode" TEXT,
  "capturedPaymentId" TEXT,
  "paymentMethod" TEXT,
  "paidAt" TIMESTAMP(3),
  "notesJson" JSONB,
  "refundAmount" DECIMAL(12,2),
  "razorpayRefundId" TEXT,
  "refundStatus" TEXT NOT NULL DEFAULT 'none',
  "refundedAt" TIMESTAMP(3),
  "refundInitiatedByAdminId" UUID,

  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orders_razorpayOrderId_key" ON "orders"("razorpayOrderId");
CREATE UNIQUE INDEX "orders_receipt_key" ON "orders"("receipt");
-- The same gateway payment can never be the captured attempt of two orders.
-- This is the database-level half of the duplicate-charge guard; the service
-- layer refuses to overwrite a set capturedPaymentId as the other half.
CREATE UNIQUE INDEX "orders_capturedPaymentId_key" ON "orders"("capturedPaymentId");

CREATE INDEX "orders_bookingId_createdAt_idx" ON "orders"("bookingId", "createdAt");
CREATE INDEX "orders_customerId_createdAt_idx" ON "orders"("customerId", "createdAt");
CREATE INDEX "orders_status_idx" ON "orders"("status");
-- Reconciliation and the refund sweep both read by this alone.
CREATE INDEX "orders_refundStatus_idx" ON "orders"("refundStatus");

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_bookingId_fkey" FOREIGN KEY ("bookingId")
    REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId")
    REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "orders_refundInitiatedByAdminId_fkey" FOREIGN KEY ("refundInitiatedByAdminId")
    REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_status_check"
    CHECK ("status" IN ('created', 'attempted', 'paid')),
  ADD CONSTRAINT "orders_refundStatus_check"
    CHECK ("refundStatus" IN ('none', 'initiated', 'settled', 'failed')),
  -- A paid order without the reference to the attempt that paid it is
  -- unreconcilable and unrefundable. The pair travels together or not at all.
  ADD CONSTRAINT "orders_paid_has_capture_check"
    CHECK ("status" <> 'paid' OR ("capturedPaymentId" IS NOT NULL AND "paidAt" IS NOT NULL)),
  -- You cannot refund what was never captured.
  ADD CONSTRAINT "orders_refund_requires_capture_check"
    CHECK ("refundStatus" = 'none' OR "capturedPaymentId" IS NOT NULL),
  -- Cumulative refunds can never exceed what the gateway actually took.
  ADD CONSTRAINT "orders_refund_within_paid_check"
    CHECK ("refundAmount" IS NULL OR "refundAmount" <= "amountPaid"),
  ADD CONSTRAINT "orders_amounts_non_negative_check"
    CHECK ("amount" >= 0 AND "amountPaid" >= 0 AND "amountDue" >= 0);

-- ---------------------------------------------------------------------
-- Cash · the store of record
-- ---------------------------------------------------------------------

ALTER TABLE "bookings"
  ADD COLUMN "cashCollectedAmount" DECIMAL(12,2),
  ADD COLUMN "cashCollectedAt" TIMESTAMP(3),
  ADD COLUMN "cashDeclinedAt" TIMESTAMP(3),
  ADD COLUMN "cashDeclinedReason" TEXT;

ALTER TABLE "bookings"
  -- An online booking's money is at the gateway. If these columns are ever
  -- populated on one, a report summing both modes double-counts it.
  ADD CONSTRAINT "bookings_cash_columns_are_cash_only_check"
    CHECK ("paymentMode" = 'cash'
           OR ("cashCollectedAmount" IS NULL AND "cashCollectedAt" IS NULL
               AND "cashDeclinedAt" IS NULL)),
  -- The amount is flatPrice or nothing — feature 13. A Pro cannot record a
  -- part payment, and this is where that is actually enforced.
  ADD CONSTRAINT "bookings_cash_collected_is_flat_price_check"
    CHECK ("cashCollectedAmount" IS NULL OR "cashCollectedAmount" = "flatPrice"),
  -- Amount and timestamp are one fact.
  ADD CONSTRAINT "bookings_cash_collection_paired_check"
    CHECK (("cashCollectedAmount" IS NULL) = ("cashCollectedAt" IS NULL)),
  -- Collected and declined are mutually exclusive outcomes of the same moment.
  ADD CONSTRAINT "bookings_cash_collected_xor_declined_check"
    CHECK ("cashCollectedAt" IS NULL OR "cashDeclinedAt" IS NULL);

ALTER TABLE "pros"
  ADD COLUMN "cashInHand" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "pros"
  -- A negative balance means more was handed over than was ever collected,
  -- which is an accounting error rather than a state a Pro can be in.
  ADD CONSTRAINT "pros_cashInHand_non_negative_check" CHECK ("cashInHand" >= 0);

CREATE TABLE "cash_handovers" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "proId" UUID NOT NULL,
  "declaredAmount" DECIMAL(12,2) NOT NULL,
  "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'declared',
  "confirmedAmount" DECIMAL(12,2),
  "confirmedAt" TIMESTAMP(3),
  "confirmedByAdminId" UUID,
  "rejectionReason" TEXT,
  "notes" TEXT,

  CONSTRAINT "cash_handovers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cash_handovers_proId_status_idx" ON "cash_handovers"("proId", "status");
CREATE INDEX "cash_handovers_status_declaredAt_idx" ON "cash_handovers"("status", "declaredAt");
-- One open declaration per Pro. Two in flight would let the same banknotes be
-- confirmed twice and drive cashInHand below what is really owed.
CREATE UNIQUE INDEX "cash_handovers_one_open_per_pro_key"
  ON "cash_handovers"("proId") WHERE "status" = 'declared';

ALTER TABLE "cash_handovers"
  ADD CONSTRAINT "cash_handovers_proId_fkey" FOREIGN KEY ("proId")
    REFERENCES "pros"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cash_handovers_confirmedByAdminId_fkey" FOREIGN KEY ("confirmedByAdminId")
    REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cash_handovers"
  ADD CONSTRAINT "cash_handovers_status_check"
    CHECK ("status" IN ('declared', 'confirmed', 'rejected')),
  ADD CONSTRAINT "cash_handovers_declaredAmount_positive_check"
    CHECK ("declaredAmount" > 0),
  -- Confirmation is the only thing that moves money, so it must carry who
  -- counted it, when, and how much. Attribution is not optional here the way
  -- it was dropped elsewhere (#2, #9, #14) — this one clears a balance.
  ADD CONSTRAINT "cash_handovers_confirmed_is_attributed_check"
    CHECK ("status" <> 'confirmed'
           OR ("confirmedAmount" IS NOT NULL AND "confirmedAt" IS NOT NULL
               AND "confirmedByAdminId" IS NOT NULL)),
  ADD CONSTRAINT "cash_handovers_confirmedAmount_non_negative_check"
    CHECK ("confirmedAmount" IS NULL OR "confirmedAmount" >= 0),
  ADD CONSTRAINT "cash_handovers_rejected_has_reason_check"
    CHECK ("status" <> 'rejected' OR "rejectionReason" IS NOT NULL);

-- ---------------------------------------------------------------------
-- Tunables — no magic numbers (cross-cutting Config rule)
-- ---------------------------------------------------------------------
-- Two of these are the numbers the feature list itself calls undefined, and
-- says carry the whole cash risk. Giving them defaults does not resolve that
-- risk; it makes it adjustable without a deploy and visible in one place.

INSERT INTO "platform_settings" (
  "id", "createdAt", "updatedAt", "key", "cityId", "value", "description"
) VALUES
  ('00000000-0000-4000-8000-000000000031', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'payments.cashEnabled', NULL, 'true', 'City-scoped cash gate. Set a per-city row to false to stop offering cash there without touching the catalogue.'),
  ('00000000-0000-4000-8000-000000000032', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'payments.cashInHandCeilingAmount', NULL, '10000', 'Once a Pro carries more than this, cash bookings stop being assigned to them until they hand over. Online work is unaffected.'),
  ('00000000-0000-4000-8000-000000000033', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'payments.orderValidityMinutes', NULL, '15', 'How long a created Razorpay order is offered before checkout reissues a new one.'),
  ('00000000-0000-4000-8000-000000000034', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'payments.reconciliationVarianceTolerance', NULL, '0', 'Rupee variance between our captured amount and Razorpay''s before reconciliation reports it. Zero — money differences are not rounding.'),
  ('00000000-0000-4000-8000-000000000035', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'payments.webhookDedupeTtlDays', NULL, '7', 'How long a processed Razorpay event id is remembered in Redis. A fast path only — correctness does not depend on it.');
