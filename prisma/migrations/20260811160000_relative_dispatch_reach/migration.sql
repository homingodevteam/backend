-- Module 5 · Dispatch — remove the absolute travel cap, record how far the
-- engine had to look.
--
-- Two changes that answer the same complaint: a fixed 60-minute ceiling is an
-- arbitrary number that silently refuses customers a willing Pro could have
-- served. See CONFLICTS_AND_DECISIONS #46 and #47.
--
-- WHAT REPLACES THE CAP. Nothing excludes on distance any more. Proximity
-- still dominates the ranking, but through a curve that decays and never
-- reaches zero, so a 70-minute Pro still outranks a 200-minute one instead of
-- both tying at the floor. The city boundary is now the only outer bound, and
-- that is honest: it is a real operational limit rather than a guessed number
-- applied to a guessed travel time.
--
-- `dispatch.maxTravelMinutes` is NOT deleted. It stops being an exclusion and
-- becomes nothing; the row is left in place so an operator who reads it in a
-- runbook finds an explanation rather than an absence.

-- ---------------------------------------------------------------------
-- Where the engine had to look
-- ---------------------------------------------------------------------
-- Defaults to 'area' so every historical row reads as what it was: found
-- inside the booking's own area, because widening did not exist.

ALTER TABLE "assignment_candidates"
  ADD COLUMN "searchTier" TEXT NOT NULL DEFAULT 'area';

ALTER TABLE "assignment_candidates"
  ADD CONSTRAINT "assignment_candidates_searchTier_check"
    CHECK ("searchTier" IN ('area', 'neighbouring', 'city'));

-- "Which bookings did we serve from outside their own area, and where?" —
-- the query that turns widening from an invisible fallback into a staffing
-- report.
CREATE INDEX "assignment_candidates_searchTier_idx"
  ON "assignment_candidates"("searchTier", "evaluatedAt")
  WHERE "searchTier" <> 'area';

-- ---------------------------------------------------------------------
-- Tunables
-- ---------------------------------------------------------------------

INSERT INTO "platform_settings" (
  "id", "createdAt", "updatedAt", "key", "cityId", "value", "description"
) VALUES
  ('00000000-0000-4000-8000-000000000051', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dispatch.travelSoftTargetMinutes', NULL, '30', 'The travel time proximity scores as "good". NOT a limit — nothing is excluded for exceeding it. It sets the scale of the decay curve, and a winner beyond it is logged so ops can see thin supply rather than infer it.'),
  ('00000000-0000-4000-8000-000000000052', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dispatch.neighbourMarginKm', NULL, '1', 'How far an area is expanded when looking for neighbouring areas to widen into. Small: cells that merely touch should qualify, cells across town should not.'),
  ('00000000-0000-4000-8000-000000000053', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dispatch.allowWidenBeyondArea', NULL, 'true', 'Whether dispatch may look outside the booking''s area when nobody there can take it. Set false per city to keep assignment strictly inside area boundaries.');

UPDATE "platform_settings"
SET "description" = 'RETIRED as an exclusion (#47). Nothing is refused for exceeding it; dispatch.travelSoftTargetMinutes now shapes the proximity curve instead. Kept so a runbook reference resolves to an explanation.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'dispatch.maxTravelMinutes';
