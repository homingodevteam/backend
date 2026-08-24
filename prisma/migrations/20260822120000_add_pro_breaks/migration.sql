-- Pro-owned breaks.
--
-- A SECOND availability gate, deliberately separate from `isAvailable`.
-- That column is the admin roster flag (US-6.12: the Pro cannot set it and
-- there is no route that lets them). Writing a break through it would let a
-- Pro switch themselves ON by ending a break they were never rostered for,
-- and would silently undo an admin un-rostering someone mid-break.
--
-- Dispatch reads both: `isAvailable` says ops rostered this person today,
-- `breakEndsAt` says they have not paused themselves for the next half hour.
--
-- Timestamps rather than booleans, so a break expires on its own. Nothing
-- runs to end one — every read compares against now() — which means no
-- scheduler can fall behind and strand a Pro off-duty, and an app killed
-- mid-break cannot leave them out of the dispatch pool.

ALTER TABLE "pros" ADD COLUMN "breakStartedAt" TIMESTAMP(3);
ALTER TABLE "pros" ADD COLUMN "breakEndsAt" TIMESTAMP(3);

-- A break booked for later, so no job is assigned INTO it. Dispatch assigns
-- work with a future `slotStartAt`, so a Pro who waits until 13:00 to tap
-- "break" has already been handed the 13:15 job. Declaring the window ahead
-- is the only thing that actually keeps it clear -- see `computeFreeWindow`.
ALTER TABLE "pros" ADD COLUMN "scheduledBreakStartAt" TIMESTAMP(3);
ALTER TABLE "pros" ADD COLUMN "scheduledBreakEndAt" TIMESTAMP(3);

-- `findEligiblePros` filters on this on every dispatch run, alongside the
-- existing `isAvailable` index.
CREATE INDEX "pros_breakEndsAt_idx" ON "pros"("breakEndsAt");
