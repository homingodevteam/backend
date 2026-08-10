-- Module 3 · Service Catalog — the two tables the catalog owns.
-- Field names follow ERD v10 (ServiceCategory, Service) exactly.
-- The dangling serviceId foreign keys are closed in the NEXT migration, so
-- this one can be applied on its own and the catalog seeded before the
-- constraints go on.

CREATE TABLE "service_categories" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "iconUrl" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "parentCategoryId" UUID,
  CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id"),
  -- A category cannot be its own parent. Deeper cycles and the two-level
  -- depth bound are service-layer rules; this catches the trivial case at
  -- the only place it can never be bypassed.
  CONSTRAINT "service_categories_not_self_parent_check"
    CHECK ("parentCategoryId" IS NULL OR "parentCategoryId" <> "id")
);

CREATE TABLE "services" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "categoryId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "durationMinutes" INTEGER NOT NULL,
  "flatPrice" DECIMAL(12,2) NOT NULL,
  "commissionType" TEXT,
  "commissionValue" DECIMAL(12,2),
  "supportsInstant" BOOLEAN NOT NULL DEFAULT true,
  "supportsScheduled" BOOLEAN NOT NULL DEFAULT true,
  "supportsRecurring" BOOLEAN NOT NULL DEFAULT false,
  -- Draft by default: a service must be explicitly activated, and activation
  -- is refused unless a commission rate is set (US-3.11).
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "services_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "services_durationMinutes_check" CHECK ("durationMinutes" > 0),
  CONSTRAINT "services_flatPrice_check" CHECK ("flatPrice" >= 0),
  CONSTRAINT "services_commissionType_check"
    CHECK ("commissionType" IS NULL OR "commissionType" IN ('percent', 'flat')),
  -- A percentage rate above 100 would pay the Pro more than the customer paid.
  CONSTRAINT "services_commissionValue_check"
    CHECK (
      "commissionValue" IS NULL
      OR (
        "commissionValue" >= 0
        AND ("commissionType" <> 'percent' OR "commissionValue" <= 100)
      )
    ),
  -- The database's own guarantee behind US-3.11: an active service always
  -- carries a complete commission configuration, whatever the API does.
  CONSTRAINT "services_active_requires_commission_check"
    CHECK (
      "isActive" = false
      OR ("commissionType" IS NOT NULL AND "commissionValue" IS NOT NULL)
    ),
  -- A live service no booking flow can reach is a configuration error.
  CONSTRAINT "services_active_requires_booking_type_check"
    CHECK (
      "isActive" = false
      OR "supportsInstant" OR "supportsScheduled" OR "supportsRecurring"
    )
);

CREATE UNIQUE INDEX "service_categories_slug_key" ON "service_categories"("slug");
CREATE INDEX "service_categories_parentCategoryId_sortOrder_idx" ON "service_categories"("parentCategoryId", "sortOrder");
CREATE INDEX "service_categories_isActive_idx" ON "service_categories"("isActive");

-- Browse is always "active services in this category, by name", which this
-- index answers directly. Search is a case-insensitive substring match: at a
-- national catalogue of tens-to-hundreds of rows that is a sequential scan by
-- design, and pg_trgm is deliberately not required (it needs a CREATE
-- EXTENSION privilege the app role on RDS may not have).
CREATE INDEX "services_categoryId_name_idx" ON "services"("categoryId", "name");
CREATE INDEX "services_isActive_idx" ON "services"("isActive");

ALTER TABLE "service_categories"
  ADD CONSTRAINT "service_categories_parentCategoryId_fkey"
  FOREIGN KEY ("parentCategoryId") REFERENCES "service_categories"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT is what stops US-3.8's orphaned services: the database refuses to
-- delete a category that still has services, rather than the application
-- remembering to check.
ALTER TABLE "services"
  ADD CONSTRAINT "services_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "service_categories"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
