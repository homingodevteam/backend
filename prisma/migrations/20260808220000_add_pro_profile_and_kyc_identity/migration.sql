-- M6 profile fields and per-application legal identity snapshot.
ALTER TABLE "pros"
ADD COLUMN "profilePhotoUrl" TEXT,
ADD COLUMN "dateOfBirth" DATE,
ADD COLUMN "gender" TEXT,
ADD COLUMN "languages" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "emergencyContactName" TEXT,
ADD COLUMN "emergencyContactPhone" TEXT,
ADD COLUMN "emergencyContactRelation" TEXT,
ADD COLUMN "addressLine" TEXT;

ALTER TABLE "pro_applications"
ADD COLUMN "documentFullName" TEXT,
ADD COLUMN "documentDateOfBirth" DATE,
ADD COLUMN "documentGender" TEXT,
ADD COLUMN "aadhaarVerifiedByType" TEXT,
ADD COLUMN "panVerifiedByType" TEXT;

-- Preserve the old actor meaning before converting verifier IDs to UUID FKs.
UPDATE "pro_applications"
SET "aadhaarVerifiedByType" = CASE
  WHEN "aadhaarVerifiedByAdminId" = 'system' THEN 'system'
  WHEN "aadhaarVerifiedByAdminId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM "admin_users"
      WHERE "admin_users"."id"::text = "pro_applications"."aadhaarVerifiedByAdminId"
    ) THEN 'admin'
  ELSE NULL
END,
"panVerifiedByType" = CASE
  WHEN "panVerifiedByAdminId" = 'system' THEN 'system'
  WHEN "panVerifiedByAdminId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM "admin_users"
      WHERE "admin_users"."id"::text = "pro_applications"."panVerifiedByAdminId"
    ) THEN 'admin'
  ELSE NULL
END;

ALTER TABLE "pro_applications"
ALTER COLUMN "aadhaarVerifiedByAdminId" TYPE UUID USING (
  CASE
    WHEN "aadhaarVerifiedByType" = 'admin'
      THEN "aadhaarVerifiedByAdminId"::uuid
    ELSE NULL
  END
),
ALTER COLUMN "panVerifiedByAdminId" TYPE UUID USING (
  CASE
    WHEN "panVerifiedByType" = 'admin'
      THEN "panVerifiedByAdminId"::uuid
    ELSE NULL
  END
);

ALTER TABLE "pro_applications"
ADD CONSTRAINT "pro_applications_aadhaarVerifiedByAdminId_fkey"
FOREIGN KEY ("aadhaarVerifiedByAdminId") REFERENCES "admin_users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "pro_applications_panVerifiedByAdminId_fkey"
FOREIGN KEY ("panVerifiedByAdminId") REFERENCES "admin_users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pro_applications"
ADD CONSTRAINT "pro_applications_aadhaar_verifier_actor_check"
CHECK (
  ("aadhaarVerifiedByType" IS NULL AND "aadhaarVerifiedByAdminId" IS NULL)
  OR ("aadhaarVerifiedByType" = 'system' AND "aadhaarVerifiedByAdminId" IS NULL)
  OR ("aadhaarVerifiedByType" = 'admin' AND "aadhaarVerifiedByAdminId" IS NOT NULL)
),
ADD CONSTRAINT "pro_applications_pan_verifier_actor_check"
CHECK (
  ("panVerifiedByType" IS NULL AND "panVerifiedByAdminId" IS NULL)
  OR ("panVerifiedByType" = 'system' AND "panVerifiedByAdminId" IS NULL)
  OR ("panVerifiedByType" = 'admin' AND "panVerifiedByAdminId" IS NOT NULL)
);

CREATE INDEX "pro_applications_aadhaarVerifiedByAdminId_idx"
ON "pro_applications"("aadhaarVerifiedByAdminId");
CREATE INDEX "pro_applications_panVerifiedByAdminId_idx"
ON "pro_applications"("panVerifiedByAdminId");

-- Repair historical duplicate open attempts before enforcing the invariant.
WITH ranked_open_attempts AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "proId" ORDER BY "createdAt" DESC, "id" DESC
         ) AS attempt_rank
  FROM "pro_applications"
  WHERE "decision" IS NULL OR "decision" = 'changes_requested'
)
UPDATE "pro_applications" AS application
SET "decision" = 'rejected',
    "queueStatus" = 'rejected',
    "decisionAt" = CURRENT_TIMESTAMP,
    "rejectionReason" = COALESCE(
      application."rejectionReason",
      'Superseded by a newer open application during M6 migration'
    )
FROM ranked_open_attempts
WHERE application."id" = ranked_open_attempts."id"
  AND ranked_open_attempts.attempt_rank > 1;

CREATE UNIQUE INDEX "pro_applications_one_open_attempt_per_pro_key"
ON "pro_applications"("proId")
WHERE "decision" IS NULL OR "decision" = 'changes_requested';
