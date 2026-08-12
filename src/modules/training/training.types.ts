/**
 * Module 10 · Training — the shared vocabulary.
 *
 * ## There is no enrolment table for online modules
 *
 * What a Pro must study is a **query**, not a list somebody maintains:
 *
 *     Pro → ProService (isActive) → Service → categoryId → walk ancestors
 *         → TrainingModule for that set of categories
 *
 * So assigning a service to a Pro changes their curriculum in the same
 * instant, and there is no second copy of the answer free to drift from the
 * first. The ancestor walk is what makes "trade-level" mean anything in a
 * category tree: a module attached to Plumbing reaches every Pro who does any
 * plumbing service; one attached to Drainage reaches only those.
 */

export const CONTENT_TYPES = ['video', 'doc', 'checklist', 'quiz'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const PROGRESS_STATUSES = [
  'not_started',
  'in_progress',
  'completed',
] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export const SESSION_STATUSES = ['scheduled', 'held', 'cancelled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const TRAINING_SETTINGS = {
  /**
   * Whether mandatory modules actually block activating a Pro for a service.
   *
   * **Ships `false`**, the same way `geo.enforceAreaServiceAvailability` does
   * and for the same reason: switching on a gate before the content behind it
   * exists blocks every Pro activation on the platform, and the cause is not
   * obvious from the error. Turn it on per city once a trade's mandatory
   * modules are loaded.
   */
  gateActivation: { key: 'training.gateActivation', fallback: false },
  /** Attempts before `lockedAt`. An admin can clear it. */
  maxQuizAttempts: { key: 'training.maxQuizAttempts', fallback: 3 },
  /** Overridden per module by `TrainingModule.quizPassPercent`. */
  quizPassPercent: { key: 'training.quizPassPercent', fallback: 70 },
} as const;

/**
 * Six hours on a training content URL, against the five minutes every other
 * private object in this codebase gets.
 *
 * A 48 MB video pulled down over Indian mobile data has to finish downloading
 * *and* survive being watched. Safe here and nowhere else: platform-authored
 * training material is identical for every Pro, so a longer window is a
 * convenience risk rather than a disclosure one.
 */
export const CONTENT_URL_TTL_SECONDS = 6 * 60 * 60;

/** Above this, a video is a wifi job rather than something to stream on data. */
export const WIFI_RECOMMENDED_BYTES = 10 * 1024 * 1024;
