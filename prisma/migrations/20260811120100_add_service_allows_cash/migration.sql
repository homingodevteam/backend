-- Module 7 · Payments — the per-service half of the cash gate.
--
-- Deliberately its own migration, and deliberately last.
--
-- `services` belongs to module 3, and CONFLICTS_AND_DECISIONS #13 declined
-- this exact column three days ago on the grounds that the ERD wins. #37
-- reverses that, because the cash ceiling and the uncollectable cancellation
-- fee make cash a per-service risk that `Booking.paymentMode` cannot express.
--
-- Keeping it separate means it can be dropped whole — schema, migration and
-- the guard that reads it — without unpicking the rest of module 7, if the
-- catalogue owner would rather cash stayed city-scoped only.
--
-- Defaults to true so nothing that was bookable as cash yesterday stops being
-- bookable today.

ALTER TABLE "services"
  ADD COLUMN "allowsCash" BOOLEAN NOT NULL DEFAULT true;
