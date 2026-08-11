-- Suspension reason was previously only written onto the Booking rows that
-- had to be reassigned, so a Pro suspended with no live work left no record
-- of why. These columns make the reason durable on the Pro itself.
ALTER TABLE "pros" ADD COLUMN "suspendedReason" TEXT;
ALTER TABLE "pros" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "pros" ADD COLUMN "suspendedByAdminId" UUID;

ALTER TABLE "pros"
  ADD CONSTRAINT "pros_suspendedByAdminId_fkey"
  FOREIGN KEY ("suspendedByAdminId") REFERENCES "admin_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "pros_suspendedByAdminId_idx" ON "pros"("suspendedByAdminId");
