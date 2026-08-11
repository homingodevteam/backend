-- Module 13 · Naming a generated grid.
--
-- A generated cell arrives called `A1`. Nothing in the product told an admin
-- that A1 is Sudama Nagar and C3 is Vijay Nagar — the only way to find out was
-- to copy four coordinates into Google Maps, thirty-six times per city. That is
-- not a workflow, and it is exactly where someone mislabels a cell and only
-- discovers it when bookings go to the wrong Pros.
--
-- Two columns fix it:
--
--   gridRef     the positional label, kept AFTER renaming. Ops keeps saying
--               "cell C3" long after it became "Vijay Nagar", and without this
--               that shared reference is destroyed by the rename.
--
--   nameSource  where `name` came from. The reverse-geocoding pass only ever
--               overwrites `generated`, so a suggestion can never clobber a
--               name a human chose — and an admin can see at a glance which
--               cells are still unreviewed placeholders.
--
-- Existing rows default to `manual`, which is truthful: the seeded Indore areas
-- were named by hand, and nothing should later overwrite them.

ALTER TABLE "areas"
  ADD COLUMN "gridRef" TEXT,
  ADD COLUMN "nameSource" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "areas"
  ADD CONSTRAINT "areas_nameSource_check"
    CHECK ("nameSource" IN ('generated', 'geocoded', 'manual'));

-- "Which cells has nobody reviewed yet?" — the query that turns a 36-cell grid
-- from a wall of placeholders into a finite worklist. Partial, because once a
-- city is set up almost every row is `manual` and indexing those is dead weight.
CREATE INDEX "areas_unreviewed_idx"
  ON "areas"("cityId", "nameSource")
  WHERE "nameSource" <> 'manual';
