-- Module 3 · Close the two deliberately-dangling serviceId foreign keys.
--
-- Until now `pro_services.serviceId` and `bookings.serviceId` were bare TEXT
-- columns with no constraint, because the Service catalog did not exist —
-- nothing validated them and any string was accepted. The ERD has always
-- drawn them as real foreign keys (Service.id < ProService.serviceId,
-- Service.id < Booking.serviceId); this migration makes that true.
--
-- HIGH BLAST RADIUS. Read before running on a shared instance:
--   * If both tables are empty, this is a clean type change.
--   * If either holds rows, every existing serviceId must already be a valid
--     uuid AND already exist in "services". Seed the catalog and remap the
--     old values FIRST. The guard below stops the migration with a readable
--     message instead of a raw cast error.

DO $$
DECLARE
  bad_pro_services BIGINT;
  bad_bookings BIGINT;
BEGIN
  SELECT count(*) INTO bad_pro_services
  FROM "pro_services"
  WHERE "serviceId" !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  SELECT count(*) INTO bad_bookings
  FROM "bookings"
  WHERE "serviceId" !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  IF bad_pro_services > 0 OR bad_bookings > 0 THEN
    RAISE EXCEPTION
      'Cannot link serviceId foreign keys: % pro_services row(s) and % bookings row(s) hold a serviceId that is not a uuid. Seed the catalog and remap these rows to real services.id values, then re-run.',
      bad_pro_services, bad_bookings;
  END IF;
END $$;

ALTER TABLE "pro_services"
  ALTER COLUMN "serviceId" TYPE UUID USING "serviceId"::uuid;

ALTER TABLE "bookings"
  ALTER COLUMN "serviceId" TYPE UUID USING "serviceId"::uuid;

-- RESTRICT, not CASCADE: deleting a service must never silently delete the
-- Pros' competency records or a customer's booking history. US-3.7 requires
-- deactivation (isActive = false) as the way to retire a service.
ALTER TABLE "pro_services"
  ADD CONSTRAINT "pro_services_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "services"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "services"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
