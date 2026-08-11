-- Module 13 groundwork · Service areas.
--
-- Until now, "can this customer book this service" had exactly one answer:
-- `City.isActive` (CONFLICTS_AND_DECISIONS #8). A city was either open or shut,
-- and every service in it was equally available everywhere. That cannot express
-- the thing the business actually does — AC repair in Vijay Nagar but not Rau.
--
-- `areas` is the unit that answers it, and `area_services` is the answer.
--
-- GEOMETRY, STATED PLAINLY: an area is an axis-aligned RECTANGLE in lat/lng.
-- The shape is the point — rectangles TILE. A generated grid covers a city
-- with no gaps and no overlap by construction, which removes the whole class
-- of problem a circle model has to manage. See CONFLICTS_AND_DECISIONS #42.
--
-- BOUNDS ARE HALF-OPEN: min <= value < max. That asymmetry is what makes a
-- pin landing exactly on a shared edge belong to exactly one cell instead of
-- two or none — and pins land on shared edges more often than intuition
-- suggests, because adjacent cells are generated from the same arithmetic and
-- so share bit-identical boundaries.
--
-- Resolution is therefore an indexed range query, not a scan with
-- trigonometry. Haversine still exists for dispatch's travel-time ranking; it
-- simply no longer decides which area a pin is in.
--
-- Not PostGIS, and not because PostGIS is wrong. The entire geometry question
-- lives in one function (`resolveArea`), so a `geography(Polygon)` column can
-- replace the rectangle later without a single caller changing.
--
-- Additive only. Every existing booking gets a NULL areaId, which is the
-- truthful value: it was taken before areas existed.

-- ---------------------------------------------------------------------
-- areas
-- ---------------------------------------------------------------------

CREATE TABLE "areas" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "cityId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  -- Half-open on both axes: minLat <= lat < maxLat AND minLng <= lng < maxLng.
  "minLat" DOUBLE PRECISION NOT NULL,
  "maxLat" DOUBLE PRECISION NOT NULL,
  "minLng" DOUBLE PRECISION NOT NULL,
  "maxLng" DOUBLE PRECISION NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- Two areas called "Vijay Nagar" in one city is an ops mistake, not a model.
CREATE UNIQUE INDEX "areas_cityId_name_key" ON "areas"("cityId", "name");
CREATE INDEX "areas_cityId_isActive_idx" ON "areas"("cityId", "isActive");
-- What resolveArea reads. Latitude leads because it is the more selective of
-- the two across a city-sized grid.
CREATE INDEX "areas_bounds_idx" ON "areas"("minLat", "maxLat", "minLng", "maxLng");

ALTER TABLE "areas"
  ADD CONSTRAINT "areas_cityId_fkey" FOREIGN KEY ("cityId")
    REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "areas"
  -- Coordinates that are merely *plausible* are the ones that cause trouble:
  -- a swapped lat/lng for Indore (75.89, 22.75) is a valid-looking pair that
  -- silently lands in the Arabian Sea and resolves nobody.
  ADD CONSTRAINT "areas_lat_range_check"
    CHECK ("minLat" BETWEEN -90 AND 90 AND "maxLat" BETWEEN -90 AND 90),
  ADD CONSTRAINT "areas_lng_range_check"
    CHECK ("minLng" BETWEEN -180 AND 180 AND "maxLng" BETWEEN -180 AND 180),
  -- Strictly greater, not >=. A degenerate box with zero height or width is
  -- syntactically fine, satisfies min <= max, and silently matches nothing
  -- forever — the worst kind of configuration error because it looks correct.
  ADD CONSTRAINT "areas_bounds_ordered_check"
    CHECK ("maxLat" > "minLat" AND "maxLng" > "minLng");

-- ---------------------------------------------------------------------
-- area_services — the row that makes per-area availability expressible
-- ---------------------------------------------------------------------
-- AVAILABILITY ONLY. Price stays national and per-service: there are still no
-- per-area price rows, and Booking.flatPrice is still snapshotted from
-- Service.flatPrice at creation.

CREATE TABLE "area_services" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "areaId" UUID NOT NULL,
  "serviceId" UUID NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "area_services_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "area_services_areaId_serviceId_key"
  ON "area_services"("areaId", "serviceId");
-- "Where can I get AC repair?" reads by this alone.
CREATE INDEX "area_services_serviceId_isActive_idx"
  ON "area_services"("serviceId", "isActive");

ALTER TABLE "area_services"
  ADD CONSTRAINT "area_services_areaId_fkey" FOREIGN KEY ("areaId")
    REFERENCES "areas"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "area_services_serviceId_fkey" FOREIGN KEY ("serviceId")
    REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- pro_areas — where a Pro is posted
-- ---------------------------------------------------------------------
-- A FILTER on dispatch, never the ranking. Distance and travel time still
-- order candidates; this only says where a Pro is expected to work. A Pro
-- posted to Vijay Nagar may physically be anywhere while travelling, and it is
-- their LIVE position that gets scored.

CREATE TABLE "pro_areas" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "proId" UUID NOT NULL,
  "areaId" UUID NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "pro_areas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pro_areas_proId_areaId_key" ON "pro_areas"("proId", "areaId");
CREATE INDEX "pro_areas_areaId_isActive_idx" ON "pro_areas"("areaId", "isActive");

ALTER TABLE "pro_areas"
  ADD CONSTRAINT "pro_areas_proId_fkey" FOREIGN KEY ("proId")
    REFERENCES "pros"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "pro_areas_areaId_fkey" FOREIGN KEY ("areaId")
    REFERENCES "areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- The snapshot
-- ---------------------------------------------------------------------
-- Only on `bookings`, and deliberately NOT on `customer_addresses`. An areaId
-- there would be a cache nothing maintains — the customers module cannot reach
-- module 13 without a dependency cycle, and booking re-resolves from the pin
-- regardless, because areas get redrawn after an address is saved. The app
-- asks GET /geo/serviceability with the pin before saving, which answers the
-- same question without a column that can go stale.

ALTER TABLE "bookings"
  ADD COLUMN "areaId" UUID;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_areaId_fkey" FOREIGN KEY ("areaId")
    REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- "How much work came out of Vijay Nagar this month" — the question areas
-- exist to make answerable.
CREATE INDEX "bookings_areaId_createdAt_idx" ON "bookings"("areaId", "createdAt");

-- ---------------------------------------------------------------------
-- Tunables
-- ---------------------------------------------------------------------

INSERT INTO "platform_settings" (
  "id", "createdAt", "updatedAt", "key", "cityId", "value", "description"
) VALUES
  ('00000000-0000-4000-8000-000000000041', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'geo.defaultCellSizeKm', NULL, '6', 'Cell side length suggested when generating a city grid. Only a default offered to the admin — the stored bounds are what actually resolve.'),
  ('00000000-0000-4000-8000-000000000042', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'geo.enforceAreaServiceAvailability', NULL, 'false', 'Whether booking creation REFUSES a service not listed for the resolved area. Ships false: with no areas defined yet, true would reject every booking in the product. Flip per city once that city is mapped.');
