-- Module 11 · Safety. The alarm the customer app raises, and the queue ops
-- answers it from.
--
-- The context columns (addressText, serviceTitle, proName, contactPhone) are
-- deliberately denormalised copies of data reachable through bookingId. An
-- SOS is evidence: it has to keep saying what it said when it was raised,
-- even after the booking is reassigned or the address is edited.

CREATE TABLE "sos_alerts" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    "customerId" UUID NOT NULL,
    "bookingId" UUID,

    "status" TEXT NOT NULL DEFAULT 'active',
    "raisedAt" TIMESTAMP(3) NOT NULL,

    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "locationAccuracyM" DOUBLE PRECISION,
    "locationAt" TIMESTAMP(3),

    "addressText" TEXT,
    "serviceTitle" TEXT,
    "proName" TEXT,
    "contactPhone" TEXT,

    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByAdminId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNotes" TEXT,

    "clientAlertId" TEXT,

    CONSTRAINT "sos_alerts_pkey" PRIMARY KEY ("id")
);

-- The idempotency key behind the app's offline retry queue: a queued alarm
-- may be drained more than once and must still create exactly one row.
CREATE UNIQUE INDEX "sos_alerts_clientAlertId_key" ON "sos_alerts"("clientAlertId");

-- The live queue ops sits on all day.
CREATE INDEX "sos_alerts_status_raisedAt_idx" ON "sos_alerts"("status", "raisedAt");
CREATE INDEX "sos_alerts_customerId_raisedAt_idx" ON "sos_alerts"("customerId", "raisedAt");
CREATE INDEX "sos_alerts_bookingId_idx" ON "sos_alerts"("bookingId");

-- Restrict on the customer: an alarm outlives the account that raised it.
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SetNull on the booking: losing the job must never delete the incident.
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_acknowledgedByAdminId_fkey"
    FOREIGN KEY ("acknowledgedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
