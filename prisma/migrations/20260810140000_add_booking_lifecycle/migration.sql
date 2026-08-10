-- Module 4 · Booking & Job Lifecycle.
--
-- `bookings` and `booking_status_events` already existed as stubs, created in
-- the M6 pass purely so the Pro counters had something to count. This fills
-- them out to ERD v10 and adds the three tables module 4 owns outright.
--
-- NOTE ON `flatPrice`: it is NOT NULL, because every booking has a price from
-- the instant it exists — there is no state in which one does not, and making
-- it nullable would permanently weaken the guarantee US-3.2 depends on. The
-- guard below refuses the migration rather than inventing a price for rows
-- that predate the column.

DO $$
DECLARE
  existing_bookings BIGINT;
BEGIN
  SELECT count(*) INTO existing_bookings FROM "bookings";

  IF existing_bookings > 0 THEN
    RAISE EXCEPTION
      'Cannot add bookings.flatPrice as NOT NULL: % existing booking row(s) have no price. Backfill them from services.flatPrice first, or drop them if they are test data.',
      existing_bookings;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Booking — creation, payment mode, OTP, execution, invoice, cancellation
-- ---------------------------------------------------------------------

ALTER TABLE "bookings"
  ADD COLUMN "bookingType" TEXT NOT NULL DEFAULT 'instant',
  ADD COLUMN "recurringPlanId" UUID,
  ADD COLUMN "rebookedFromBookingId" UUID,
  ADD COLUMN "slotStartAt" TIMESTAMP(3),
  ADD COLUMN "slotEndAt" TIMESTAMP(3),
  ADD COLUMN "flatPrice" DECIMAL(12,2) NOT NULL,
  ADD COLUMN "paymentMode" TEXT NOT NULL DEFAULT 'cash',
  ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
  ADD COLUMN "startOtpProviderRef" TEXT,
  ADD COLUMN "startOtpAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "startOtpVerifiedByProId" UUID,
  ADD COLUMN "routeTrail" JSONB,
  ADD COLUMN "invoiceNumber" TEXT,
  ADD COLUMN "invoicePdfUrl" TEXT,
  ADD COLUMN "taxAmount" DECIMAL(12,2),
  ADD COLUMN "invoicedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "cancelledByType" TEXT,
  ADD COLUMN "cancellationFeeAmount" DECIMAL(12,2),
  ADD COLUMN "refundedAmount" DECIMAL(12,2);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_bookingType_check"
    CHECK ("bookingType" IN ('instant', 'scheduled', 'recurring')),
  -- Frozen at creation. Nothing in the system may widen this set: a cash
  -- booking has no Order row at all, so a third mode would silently break
  -- every report that joins one.
  ADD CONSTRAINT "bookings_paymentMode_check"
    CHECK ("paymentMode" IN ('online', 'cash')),
  ADD CONSTRAINT "bookings_paymentStatus_check"
    CHECK ("paymentStatus" IN ('unpaid', 'authorized', 'paid', 'refunded')),
  ADD CONSTRAINT "bookings_status_check"
    CHECK ("status" IN (
      'created', 'awaiting_payment', 'assigning', 'assigned',
      'en_route', 'arrived', 'started', 'completed', 'cancelled'
    )),
  -- Principle 2: a Pro cannot cancel. Enforced in the service layer, and here
  -- so no future code path can route around it.
  ADD CONSTRAINT "bookings_cancelledByType_check"
    CHECK ("cancelledByType" IS NULL
           OR "cancelledByType" IN ('customer', 'ops', 'system')),
  ADD CONSTRAINT "bookings_flatPrice_check" CHECK ("flatPrice" >= 0),
  -- The trust anchor, at the storage layer: a started job has a start time,
  -- and a completed job has both.
  ADD CONSTRAINT "bookings_started_requires_startedAt_check"
    CHECK ("status" NOT IN ('started', 'completed') OR "startedAt" IS NOT NULL),
  ADD CONSTRAINT "bookings_completed_requires_completedAt_check"
    CHECK ("status" <> 'completed' OR "completedAt" IS NOT NULL),
  ADD CONSTRAINT "bookings_cancelled_requires_cancelledAt_check"
    CHECK ("status" <> 'cancelled' OR "cancelledAt" IS NOT NULL);

CREATE UNIQUE INDEX "bookings_invoiceNumber_key" ON "bookings"("invoiceNumber");
CREATE INDEX "bookings_customerId_status_idx" ON "bookings"("customerId", "status");
CREATE INDEX "bookings_status_slotStartAt_idx" ON "bookings"("status", "slotStartAt");

-- ---------------------------------------------------------------------
-- BookingStatusEvent — the coordinates that make it evidence
-- ---------------------------------------------------------------------
-- Feature 9 asks for "actor, timestamp and coordinates at every transition".
-- Without the coordinates the log is a timeline, not evidence, and US-4.10's
-- "marking arrival from 3 km away is recorded as such" is unenforceable.
-- DOUBLE PRECISION matches every other coordinate in this schema.

ALTER TABLE "booking_status_events"
  ADD COLUMN "lat" DOUBLE PRECISION,
  ADD COLUMN "lng" DOUBLE PRECISION;

-- Deliberately NO unique constraint on (bookingId, status): feature 10
-- requires repeat transitions to survive — en_route → arrived → en_route when
-- a customer is not home.

-- ---------------------------------------------------------------------
-- RecurringPlan
-- ---------------------------------------------------------------------

CREATE TABLE "recurring_plans" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "customerId" UUID NOT NULL,
  "serviceId" UUID NOT NULL,
  "addressId" UUID NOT NULL,
  "frequency" TEXT NOT NULL,
  "daysOfWeek" JSONB NOT NULL DEFAULT '[]',
  "timeOfDay" TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE,
  "nextRunAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "recurring_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recurring_plans_frequency_check"
    CHECK ("frequency" IN ('daily', 'weekly', 'biweekly', 'monthly')),
  -- Wall-clock HH:mm, interpreted in the booking city's timezone.
  CONSTRAINT "recurring_plans_timeOfDay_check"
    CHECK ("timeOfDay" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "recurring_plans_dateRange_check"
    CHECK ("endDate" IS NULL OR "endDate" >= "startDate")
);

-- ---------------------------------------------------------------------
-- ChatMessage
-- ---------------------------------------------------------------------

CREATE TABLE "chat_messages" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "bookingId" UUID NOT NULL,
  "senderType" TEXT NOT NULL,
  "senderId" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "attachmentUrl" TEXT,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id"),
  -- Ops reads the thread (US-4.24) but never joins it.
  CONSTRAINT "chat_messages_senderType_check"
    CHECK ("senderType" IN ('customer', 'pro'))
);

-- ---------------------------------------------------------------------
-- JobPhotoProof
-- ---------------------------------------------------------------------

CREATE TABLE "job_photo_proofs" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "bookingId" UUID NOT NULL,
  "proId" UUID NOT NULL,
  "photoType" TEXT NOT NULL,
  "photoUrl" TEXT NOT NULL,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "job_photo_proofs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "job_photo_proofs_photoType_check"
    CHECK ("photoType" IN ('before', 'after', 'completion'))
);

CREATE INDEX "recurring_plans_isActive_nextRunAt_idx" ON "recurring_plans"("isActive", "nextRunAt");
CREATE INDEX "recurring_plans_customerId_idx" ON "recurring_plans"("customerId");
CREATE INDEX "chat_messages_bookingId_sentAt_idx" ON "chat_messages"("bookingId", "sentAt");
CREATE INDEX "job_photo_proofs_bookingId_photoType_idx" ON "job_photo_proofs"("bookingId", "photoType");

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_recurringPlanId_fkey" FOREIGN KEY ("recurringPlanId") REFERENCES "recurring_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rebookedFromBookingId_fkey" FOREIGN KEY ("rebookedFromBookingId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_startOtpVerifiedByProId_fkey" FOREIGN KEY ("startOtpVerifiedByProId") REFERENCES "pros"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "recurring_plans" ADD CONSTRAINT "recurring_plans_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurring_plans" ADD CONSTRAINT "recurring_plans_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_plans" ADD CONSTRAINT "recurring_plans_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "customer_addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_photo_proofs" ADD CONSTRAINT "job_photo_proofs_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_photo_proofs" ADD CONSTRAINT "job_photo_proofs_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- Human-readable booking number
-- ---------------------------------------------------------------------
-- Feature 7: "human-readable booking number for support calls". Mirrors
-- pro_employee_code_seq — atomic under concurrent creation, and not
-- expressible in schema.prisma since it is not a column default.

CREATE SEQUENCE "booking_number_seq";

-- ---------------------------------------------------------------------
-- Tunables — no magic numbers (cross-cutting Config rule)
-- ---------------------------------------------------------------------
-- The cancellation windows are a proposal, not settled policy: the mechanics
-- are fixed but every timing and the fee are business decisions, so they live
-- here rather than in code.

INSERT INTO "platform_settings" (
  "id", "createdAt", "updatedAt", "key", "cityId", "value", "description"
) VALUES
  ('00000000-0000-4000-8000-000000000011', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.cancellationFeeAmount', NULL, '0', 'Window D fee (Pro en route or arrived). Default 0 — the Pro is salaried, so nothing is owed to them.'),
  ('00000000-0000-4000-8000-000000000012', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.paymentHoldWindowMinutes', NULL, '30', 'How long an online booking may sit in awaiting_payment before the expiry job cancels it.'),
  ('00000000-0000-4000-8000-000000000013', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'no_start.graceWindowMinutes', NULL, '15', 'From arrival to verified OTP start. On expiry an internal no_start ticket is raised for ops; the Pro is never told it exists.'),
  ('00000000-0000-4000-8000-000000000014', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.chatWindowHoursAfterCompletion', NULL, '24', 'Chat writes close this long after completion. Reads stay open forever — the thread is dispute evidence.'),
  ('00000000-0000-4000-8000-000000000015', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.startOtpMaxAttempts', NULL, '5', 'Failed start-OTP entries before the Pro is offered a resend. A mistyped digit is far more common than fraud.'),
  ('00000000-0000-4000-8000-000000000016', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.taxPercent', NULL, '18', 'GST applied to the flat price on the invoice.'),
  ('00000000-0000-4000-8000-000000000017', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.recurringGenerateAheadDays', NULL, '3', 'How far ahead the recurring generator creates the next occurrence.');
