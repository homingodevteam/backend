-- AlterTable: add firebaseUid nullable first, backfill, then enforce NOT NULL.
-- Existing rows predate Firebase-backed admin auth (currently just the
-- seeded super_admin) — placeholders here are overwritten with real values
-- by the next `npm run db:seed` run, which now also provisions Firebase.
ALTER TABLE "admin_users" ADD COLUMN "firebaseUid" TEXT;

UPDATE "admin_users"
SET "email" = COALESCE("email", 'pending+' || "id"::text || '@homingo.internal')
WHERE "email" IS NULL;

UPDATE "admin_users"
SET "firebaseUid" = 'PENDING_' || "id"::text
WHERE "firebaseUid" IS NULL;

ALTER TABLE "admin_users" ALTER COLUMN "email" SET NOT NULL;
ALTER TABLE "admin_users" ALTER COLUMN "firebaseUid" SET NOT NULL;

CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");
CREATE UNIQUE INDEX "admin_users_firebaseUid_key" ON "admin_users"("firebaseUid");
