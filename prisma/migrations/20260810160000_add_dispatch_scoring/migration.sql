-- Module 5 · Dispatch Engine.
--
-- `assignment_candidates` existed as a stub carrying only the outcome. This
-- adds the score inputs, which are the entire reason the table exists: US-5.9
-- and US-5.11 require ops to answer "why was this Pro chosen?" and "why wasn't
-- that one?" without escalating to engineering.
--
-- Additive only — no existing column changes, no data to backfill.

ALTER TABLE "assignment_candidates"
  ADD COLUMN "windowStart" TIMESTAMP(3),
  ADD COLUMN "windowEnd" TIMESTAMP(3),
  ADD COLUMN "originType" TEXT,
  ADD COLUMN "originLat" DOUBLE PRECISION,
  ADD COLUMN "originLng" DOUBLE PRECISION,
  ADD COLUMN "rank" INTEGER,
  ADD COLUMN "distanceKm" DOUBLE PRECISION,
  ADD COLUMN "travelTimeMinutes" INTEGER,
  ADD COLUMN "rotationScore" DOUBLE PRECISION,
  ADD COLUMN "durationFitScore" DOUBLE PRECISION,
  ADD COLUMN "finalRankScore" DOUBLE PRECISION;

ALTER TABLE "assignment_candidates"
  ADD CONSTRAINT "assignment_candidates_originType_check"
    CHECK ("originType" IS NULL
           OR "originType" IN ('current_location', 'last_job_location', 'home_base')),
  ADD CONSTRAINT "assignment_candidates_excludedReason_check"
    CHECK ("excludedReason" IS NULL
           OR "excludedReason" IN ('unavailable', 'no_service', 'out_of_range',
                                   'rotation_cooldown', 'already_tried')),
  -- A row is either scored or excluded, never both and never neither. This is
  -- what keeps "never a candidate" and "ranked and lost" distinguishable
  -- (US-5.11) no matter what writes the row.
  ADD CONSTRAINT "assignment_candidates_scored_xor_excluded_check"
    CHECK (("rank" IS NULL) <> ("excludedReason" IS NULL)),
  -- An excluded Pro cannot be the winner.
  ADD CONSTRAINT "assignment_candidates_winner_not_excluded_check"
    CHECK ("isWinner" = false OR "excludedReason" IS NULL);

-- Ops opens this by booking, newest attempt first.
CREATE INDEX "assignment_candidates_bookingId_attemptNumber_rank_idx"
  ON "assignment_candidates"("bookingId", "attemptNumber", "rank");

-- ---------------------------------------------------------------------
-- Tunables — no magic numbers
-- ---------------------------------------------------------------------

INSERT INTO "platform_settings" (
  "id", "createdAt", "updatedAt", "key", "cityId", "value", "description"
) VALUES
  ('00000000-0000-4000-8000-000000000021', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'assignment.ackWindowSeconds', NULL, '120', 'How long a Pro has to acknowledge before the attempt closes. Must exceed realistic phone-check latency, or good Pros who were simply driving lose jobs they would have taken.'),
  ('00000000-0000-4000-8000-000000000022', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dispatch.candidatePoolSize', NULL, '10', 'How many ranked candidates are persisted per attempt.'),
  ('00000000-0000-4000-8000-000000000023', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dispatch.maxAttempts', NULL, '3', 'Attempts before a booking is marked exhausted and surfaced to ops.'),
  ('00000000-0000-4000-8000-000000000024', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'rotation.cooldownJobs', NULL, '2', 'How many of this household''s recent jobs count against a Pro for rotation.'),
  ('00000000-0000-4000-8000-000000000025', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dispatch.maxTravelMinutes', NULL, '60', 'Beyond this a candidate is excluded as out_of_range.'),
  ('00000000-0000-4000-8000-000000000026', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'dispatch.assumedSpeedKmph', NULL, '20', 'Straight-line speed used to estimate travel time until Geo & Routing (module 13) provides real road times.');
