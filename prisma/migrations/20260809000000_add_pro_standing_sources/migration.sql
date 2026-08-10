ALTER TABLE "pro_applications"
DROP COLUMN IF EXISTS "digilockerRequestId",
DROP COLUMN IF EXISTS "digilockerFetchedAt";

CREATE TABLE "bookings" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "bookingNumber" TEXT NOT NULL,
  "customerId" UUID NOT NULL,
  "serviceId" TEXT NOT NULL,
  "addressId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'created',
  "proId" UUID,
  "assignmentAttempt" INTEGER NOT NULL DEFAULT 0,
  "assignedAt" TIMESTAMP(3),
  "notifiedAt" TIMESTAMP(3),
  "ackDeadlineAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "assignmentOutcome" TEXT,
  "overriddenByAdminId" UUID,
  "overrideReason" TEXT,
  "arrivedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "actualDurationMinutes" INTEGER,
  CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assignment_candidates" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "bookingId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "proId" UUID NOT NULL,
  "isWinner" BOOLEAN NOT NULL DEFAULT false,
  "ratingScore" DOUBLE PRECISION,
  "offersToday" INTEGER,
  "excludedReason" TEXT,
  "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assignment_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "booking_status_events" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "bookingId" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "booking_status_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reviews" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "bookingId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "proId" UUID NOT NULL,
  "rating" INTEGER NOT NULL,
  "comment" TEXT,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "isHidden" BOOLEAN NOT NULL DEFAULT false,
  "hiddenReason" TEXT,
  CONSTRAINT "reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reviews_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE TABLE "commission_payouts" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "proId" UUID NOT NULL,
  "bankAccountId" UUID NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "commissionAmount" DECIMAL(12,2) NOT NULL,
  "incentiveAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "deductionAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "netAmount" DECIMAL(12,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "approvedByAdminId" UUID,
  "approvedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "payoutReference" TEXT,
  CONSTRAINT "commission_payouts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "booking_commissions" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "bookingId" UUID NOT NULL,
  "proId" UUID NOT NULL,
  "customerFlatAmount" DECIMAL(12,2) NOT NULL,
  "actualDurationMinutes" INTEGER,
  "commissionType" TEXT NOT NULL,
  "commissionValue" DECIMAL(12,2) NOT NULL,
  "commissionAmount" DECIMAL(12,2) NOT NULL,
  "platformAmount" DECIMAL(12,2) NOT NULL,
  "incentiveAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "deductionAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "netPayable" DECIMAL(12,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payoutId" UUID,
  CONSTRAINT "booking_commissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_settings" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "key" TEXT NOT NULL,
  "cityId" UUID,
  "value" TEXT NOT NULL,
  "description" TEXT,
  "updatedByAdminId" UUID,
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bookings_bookingNumber_key" ON "bookings"("bookingNumber");
CREATE INDEX "bookings_proId_status_idx" ON "bookings"("proId", "status");
CREATE INDEX "bookings_customerId_createdAt_idx" ON "bookings"("customerId", "createdAt");
CREATE INDEX "bookings_addressId_proId_completedAt_idx" ON "bookings"("addressId", "proId", "completedAt");
CREATE UNIQUE INDEX "assignment_candidates_bookingId_attemptNumber_proId_key" ON "assignment_candidates"("bookingId", "attemptNumber", "proId");
CREATE INDEX "assignment_candidates_proId_isWinner_idx" ON "assignment_candidates"("proId", "isWinner");
CREATE INDEX "booking_status_events_bookingId_occurredAt_idx" ON "booking_status_events"("bookingId", "occurredAt");
CREATE INDEX "booking_status_events_actorType_actorId_status_idx" ON "booking_status_events"("actorType", "actorId", "status");
CREATE UNIQUE INDEX "reviews_bookingId_key" ON "reviews"("bookingId");
CREATE INDEX "reviews_proId_createdAt_idx" ON "reviews"("proId", "createdAt");
CREATE INDEX "commission_payouts_proId_periodEnd_idx" ON "commission_payouts"("proId", "periodEnd");
CREATE UNIQUE INDEX "booking_commissions_bookingId_key" ON "booking_commissions"("bookingId");
CREATE INDEX "booking_commissions_proId_computedAt_idx" ON "booking_commissions"("proId", "computedAt");
CREATE INDEX "booking_commissions_payoutId_idx" ON "booking_commissions"("payoutId");
CREATE UNIQUE INDEX "platform_settings_key_cityId_key" ON "platform_settings"("key", "cityId");
CREATE UNIQUE INDEX "platform_settings_global_key_key" ON "platform_settings"("key") WHERE "cityId" IS NULL;
CREATE INDEX "platform_settings_cityId_key_idx" ON "platform_settings"("cityId", "key");

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "customer_addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_overriddenByAdminId_fkey" FOREIGN KEY ("overriddenByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assignment_candidates" ADD CONSTRAINT "assignment_candidates_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assignment_candidates" ADD CONSTRAINT "assignment_candidates_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "booking_status_events" ADD CONSTRAINT "booking_status_events_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "pro_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_approvedByAdminId_fkey" FOREIGN KEY ("approvedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "booking_commissions" ADD CONSTRAINT "booking_commissions_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "booking_commissions" ADD CONSTRAINT "booking_commissions_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "booking_commissions" ADD CONSTRAINT "booking_commissions_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "commission_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updatedByAdminId_fkey" FOREIGN KEY ("updatedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "platform_settings" (
  "id", "createdAt", "updatedAt", "key", "cityId", "value", "description"
) VALUES
  ('00000000-0000-4000-8000-000000000001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dispatch.ratingPriorMean', NULL, '4', 'Global smoothed-rating prior mean'),
  ('00000000-0000-4000-8000-000000000002', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dispatch.ratingPriorWeight', NULL, '5', 'Global smoothed-rating prior weight');
