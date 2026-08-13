ALTER TABLE "areas"
  ADD COLUMN "addressLine" TEXT,
  ADD COLUMN "addressState" TEXT,
  ADD COLUMN "addressPostalCode" TEXT,
  ADD COLUMN "addressProvider" TEXT,
  ADD COLUMN "addressAttribution" TEXT,
  ADD COLUMN "addressUpdatedAt" TIMESTAMP(3);
