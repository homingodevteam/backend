-- Module 10 · Training & Reviews.
--
-- Four new tables and two altered ones. The altered ones are the interesting
-- part: `reviews` gains a direction, and that single column changes what an
-- existing nightly query means.
--
-- CONFLICTS_AND_DECISIONS #61. `ProCountersService.rebuildAll` sums every row
-- in `reviews` grouped by `proId` and writes the result to `pros.ratingSum`.
-- A Pro→customer review carries the reviewing Pro's own `proId`, because the
-- Pro is its AUTHOR — so without a direction filter the 02:00 rebuild folds a
-- Pro's opinion of a customer into that Pro's own public rating. The filter
-- ships in the same change as this migration; neither is safe alone.

-- ---------------------------------------------------------------------
-- reviews · the second direction
-- ---------------------------------------------------------------------

ALTER TABLE "reviews" ADD COLUMN "reviewerType" TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE "reviews" ADD COLUMN "photoUrls" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "reviews" ADD COLUMN "hiddenByAdminId" UUID;
ALTER TABLE "reviews" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- The default is doing real work: every row that already exists is a customer
-- review, because until now no other kind could be written. No backfill.

ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_reviewerType_check"
    CHECK ("reviewerType" IN ('customer', 'pro'));

-- `reviews_rating_check` (1..5) is NOT declared here: it already exists, from
-- 20260809000000_add_pro_standing_sources. Re-adding it is a 42710 that fails
-- the whole migration, which is how this comment came to be written.

-- The Pro direction is a controlled tag vocabulary and nothing else. Enforced
-- here as well as in the DTO because this is the rule the whole asymmetry
-- rests on: free text about a household, held internally and shown to the next
-- stranger arriving at their door, is what this design refuses.
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_pro_direction_has_no_prose_check"
    CHECK ("reviewerType" = 'customer' OR ("comment" IS NULL AND "photoUrls" = '[]'::jsonb));

-- Moderation carries a name and a reason, or it is not moderation.
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_moderation_check"
    CHECK ("isHidden" = false OR ("hiddenReason" IS NOT NULL AND "hiddenAt" IS NOT NULL));

-- One row per booking PER DIRECTION. `bookingId UNIQUE` allowed exactly one
-- review per job, which made feature 11 impossible to write at all.
DROP INDEX IF EXISTS "reviews_bookingId_key";
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_bookingId_key";
CREATE UNIQUE INDEX "reviews_bookingId_reviewerType_key"
  ON "reviews"("bookingId", "reviewerType");

ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_hiddenByAdminId_fkey" FOREIGN KEY ("hiddenByAdminId")
    REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The old index cannot serve the public profile list any more: it would scan
-- the Pro's own authored rows and filter them out per page.
DROP INDEX IF EXISTS "reviews_proId_createdAt_idx";
CREATE INDEX "reviews_proId_reviewerType_createdAt_idx"
  ON "reviews"("proId", "reviewerType", "createdAt");
-- The customer advisory: every Pro-authored row about one household.
CREATE INDEX "reviews_customerId_reviewerType_createdAt_idx"
  ON "reviews"("customerId", "reviewerType", "createdAt");
CREATE INDEX "reviews_hiddenByAdminId_idx" ON "reviews"("hiddenByAdminId");

-- ---------------------------------------------------------------------
-- customers · the mirrored counters
-- ---------------------------------------------------------------------
-- Exactly the shape of `pros.ratingSum` / `ratingCount`, rebuilt by the same
-- nightly job. Read by ops and by the next Pro's job card; consumed
-- automatically by nothing at all.

ALTER TABLE "customers" ADD COLUMN "ratingSum" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "customers" ADD COLUMN "ratingCount" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- training_modules
-- ---------------------------------------------------------------------

CREATE TABLE "training_modules" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "categoryId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "contentType" TEXT NOT NULL,
  "contentKey" TEXT,
  "contentUrl" TEXT,
  "contentBytes" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "quizAnswerKey" JSONB,
  "quizPassPercent" INTEGER,
  "isMandatory" BOOLEAN NOT NULL DEFAULT false,
  "durationMinutes" INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "training_modules_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "training_modules"
  ADD CONSTRAINT "training_modules_contentType_check"
    CHECK ("contentType" IN ('video', 'doc', 'checklist', 'quiz'));

-- Exactly one source for the content. Both set means two answers to "what does
-- the Pro open"; neither set means a module that cannot be opened at all.
ALTER TABLE "training_modules"
  ADD CONSTRAINT "training_modules_one_content_source_check"
    CHECK (("contentKey" IS NULL) <> ("contentUrl" IS NULL));

-- A quiz with no answer key cannot be graded, and grading is the whole point:
-- the score is the defensible signal, percent-watched is not.
ALTER TABLE "training_modules"
  ADD CONSTRAINT "training_modules_quiz_has_answer_key_check"
    CHECK ("contentType" <> 'quiz' OR "quizAnswerKey" IS NOT NULL);

ALTER TABLE "training_modules"
  ADD CONSTRAINT "training_modules_quizPassPercent_check"
    CHECK ("quizPassPercent" IS NULL OR "quizPassPercent" BETWEEN 1 AND 100);

ALTER TABLE "training_modules"
  ADD CONSTRAINT "training_modules_categoryId_fkey" FOREIGN KEY ("categoryId")
    REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "training_modules_categoryId_sortOrder_idx"
  ON "training_modules"("categoryId", "sortOrder");
CREATE INDEX "training_modules_isActive_idx" ON "training_modules"("isActive");

-- ---------------------------------------------------------------------
-- pro_training_progress
-- ---------------------------------------------------------------------

CREATE TABLE "pro_training_progress" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "proId" UUID NOT NULL,
  "moduleId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'not_started',
  "percentComplete" INTEGER NOT NULL DEFAULT 0,
  "lastPositionSeconds" INTEGER NOT NULL DEFAULT 0,
  "quizAttempts" INTEGER NOT NULL DEFAULT 0,
  "quizScore" DECIMAL(5,2),
  "bestQuizScore" DECIMAL(5,2),
  "lockedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "pro_training_progress_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "pro_training_progress"
  ADD CONSTRAINT "pro_training_progress_status_check"
    CHECK ("status" IN ('not_started', 'in_progress', 'completed'));

ALTER TABLE "pro_training_progress"
  ADD CONSTRAINT "pro_training_progress_percentComplete_check"
    CHECK ("percentComplete" BETWEEN 0 AND 100);

ALTER TABLE "pro_training_progress"
  ADD CONSTRAINT "pro_training_progress_lastPositionSeconds_check"
    CHECK ("lastPositionSeconds" >= 0);

-- `completed` is what the activation gate reads. A completed row with no
-- timestamp is a gate decision with no evidence behind it.
ALTER TABLE "pro_training_progress"
  ADD CONSTRAINT "pro_training_progress_completion_check"
    CHECK (("status" = 'completed') = ("completedAt" IS NOT NULL));

ALTER TABLE "pro_training_progress"
  ADD CONSTRAINT "pro_training_progress_proId_fkey" FOREIGN KEY ("proId")
    REFERENCES "pros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pro_training_progress"
  ADD CONSTRAINT "pro_training_progress_moduleId_fkey" FOREIGN KEY ("moduleId")
    REFERENCES "training_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "pro_training_progress_proId_moduleId_key"
  ON "pro_training_progress"("proId", "moduleId");
CREATE INDEX "pro_training_progress_proId_status_idx"
  ON "pro_training_progress"("proId", "status");
CREATE INDEX "pro_training_progress_moduleId_idx"
  ON "pro_training_progress"("moduleId");

-- ---------------------------------------------------------------------
-- offline_training_sessions
-- ---------------------------------------------------------------------

CREATE TABLE "offline_training_sessions" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "categoryId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "venue" TEXT NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "durationMinutes" INTEGER,
  "trainerName" TEXT,
  "capacity" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'scheduled',

  CONSTRAINT "offline_training_sessions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "offline_training_sessions"
  ADD CONSTRAINT "offline_training_sessions_status_check"
    CHECK ("status" IN ('scheduled', 'held', 'cancelled'));

ALTER TABLE "offline_training_sessions"
  ADD CONSTRAINT "offline_training_sessions_capacity_check" CHECK ("capacity" > 0);

ALTER TABLE "offline_training_sessions"
  ADD CONSTRAINT "offline_training_sessions_categoryId_fkey" FOREIGN KEY ("categoryId")
    REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "offline_training_sessions_status_scheduledAt_idx"
  ON "offline_training_sessions"("status", "scheduledAt");
CREATE INDEX "offline_training_sessions_categoryId_scheduledAt_idx"
  ON "offline_training_sessions"("categoryId", "scheduledAt");

-- ---------------------------------------------------------------------
-- offline_training_attendance
-- ---------------------------------------------------------------------

CREATE TABLE "offline_training_attendance" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sessionId" UUID NOT NULL,
  "proId" UUID NOT NULL,
  "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attended" BOOLEAN NOT NULL DEFAULT false,
  "markedByAdminId" UUID,
  "markedAt" TIMESTAMP(3),
  "completionNotes" TEXT,

  CONSTRAINT "offline_training_attendance_pkey" PRIMARY KEY ("id")
);

-- Attendance is an assertion by a named admin who was in the room.
ALTER TABLE "offline_training_attendance"
  ADD CONSTRAINT "offline_training_attendance_marking_check"
    CHECK (("markedAt" IS NULL) = ("markedByAdminId" IS NULL));

ALTER TABLE "offline_training_attendance"
  ADD CONSTRAINT "offline_training_attendance_sessionId_fkey" FOREIGN KEY ("sessionId")
    REFERENCES "offline_training_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "offline_training_attendance"
  ADD CONSTRAINT "offline_training_attendance_proId_fkey" FOREIGN KEY ("proId")
    REFERENCES "pros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "offline_training_attendance"
  ADD CONSTRAINT "offline_training_attendance_markedByAdminId_fkey"
    FOREIGN KEY ("markedByAdminId") REFERENCES "admin_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Capacity is counted from these rows, so a duplicate enrolment would consume
-- a seat that does not exist.
CREATE UNIQUE INDEX "offline_training_attendance_sessionId_proId_key"
  ON "offline_training_attendance"("sessionId", "proId");
CREATE INDEX "offline_training_attendance_proId_idx"
  ON "offline_training_attendance"("proId");
CREATE INDEX "offline_training_attendance_markedByAdminId_idx"
  ON "offline_training_attendance"("markedByAdminId");
