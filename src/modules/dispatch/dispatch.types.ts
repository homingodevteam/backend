/** Where the engine routed a candidate from. */
export const ORIGIN_TYPES = [
  'current_location',
  'last_job_location',
  'home_base',
] as const;
export type OriginType = (typeof ORIGIN_TYPES)[number];

/**
 * Why a Pro never got a rank. A row still exists for them — US-5.11 needs
 * "never a candidate" and "ranked and lost" to be different conversations.
 */
export const EXCLUSION_REASONS = [
  'unavailable',
  'no_service',
  'out_of_range',
  'rotation_cooldown',
  'already_tried',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/**
 * How an attempt ended.
 *
 * `no_supply` and `exhausted` are deliberately different: the first means
 * nobody holds this service here at all — a structural supply gap (US-5.5) —
 * and the second means candidates existed and were all tried (US-5.10).
 * Collapsing them gets a supply problem triaged as a bug for months.
 */
export const ASSIGNMENT_OUTCOMES = [
  'pending_ack',
  'acknowledged',
  'no_ack_timeout',
  'ops_reassigned',
  'cancelled',
  'no_supply',
  'exhausted',
] as const;
export type AssignmentOutcome = (typeof ASSIGNMENT_OUTCOMES)[number];

export interface FreeWindow {
  start: Date;
  end: Date;
}

export interface TravelOrigin {
  originType: OriginType;
  lat: number;
  lng: number;
}

/** One Pro, fully evaluated. Becomes exactly one `AssignmentCandidate` row. */
export interface ScoredCandidate {
  proId: string;
  window: FreeWindow | null;
  origin: TravelOrigin | null;
  distanceKm: number | null;
  travelTimeMinutes: number | null;
  rotationScore: number | null;
  durationFitScore: number | null;
  ratingScore: number | null;
  offersToday: number | null;
  finalRankScore: number | null;
  rank: number | null;
  excludedReason: ExclusionReason | null;
}

export interface DispatchSettings {
  ackWindowSeconds: number;
  candidatePoolSize: number;
  maxAttempts: number;
  rotationCooldownJobs: number;
  maxTravelMinutes: number;
  assumedSpeedKmph: number;
  ratingPriorMean: number;
  ratingPriorWeight: number;
}

/** Great-circle distance in km. */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The cold-start handling, exactly as the ground rules specify:
 * `(ratingSum + priorMean × priorWeight) / (ratingCount + priorWeight)`.
 *
 * A Pro with no reviews lands on the platform average, so there is no grace
 * flag to set and none to expire. Each real review pulls the score toward the
 * truth. This is **not** the Pro's displayed rating — a 5.0 from two reviews
 * can legitimately lose to a 4.6 from two hundred, and ops screens should show
 * both numbers or it reads as a bug (US-5.11).
 */
export function smoothedRating(
  ratingSum: number,
  ratingCount: number,
  priorMean: number,
  priorWeight: number,
): number {
  return (ratingSum + priorMean * priorWeight) / (ratingCount + priorWeight);
}

/**
 * How well the job fits the free window. 1 = the window is exactly the job;
 * lower = more slack left over.
 *
 * Preferring a tight fit packs a day efficiently instead of burning a Pro's
 * only long window on a short job.
 */
export function durationFit(
  jobMinutes: number,
  window: FreeWindow | null,
): number | null {
  if (!window) return null;
  const windowMinutes =
    (window.end.getTime() - window.start.getTime()) / 60_000;
  if (windowMinutes <= 0) return 0;
  return Math.min(1, jobMinutes / windowMinutes);
}

/**
 * Rule 3. 1 = never served this household, 0 = served it the most.
 *
 * A **penalty, not an exclusion** — a rotation-cooled Pro still beats nobody,
 * and the alternative is a booking nobody can serve because one Pro happened
 * to visit twice.
 */
export function rotationScore(
  recentJobsAtAddress: number,
  cooldown: number,
): number {
  if (cooldown <= 0) return 1;
  return Math.max(0, 1 - recentJobsAtAddress / cooldown);
}

/**
 * The composite the ranking sorts on. Higher is better.
 *
 * Weighted so proximity dominates — a Pro 40 minutes away is a worse outcome
 * for the customer than a marginally lower-rated Pro 5 minutes away. Rotation
 * and fit adjust within that; rating breaks what is left.
 *
 * **`acceptanceRate` is deliberately absent** and must stay absent. Ranking it
 * would penalise Pros for undelivered pushes and provider outages — failures
 * that are not theirs.
 */
export function finalRankScore(input: {
  travelTimeMinutes: number;
  maxTravelMinutes: number;
  rotationScore: number;
  durationFitScore: number;
  ratingScore: number;
  offersToday: number;
}): number {
  const proximity = Math.max(
    0,
    1 - input.travelTimeMinutes / Math.max(1, input.maxTravelMinutes),
  );
  // Rating is 1..5; normalise so every term is 0..1 and the weights mean
  // what they look like.
  const rating = Math.max(0, Math.min(1, (input.ratingScore - 1) / 4));
  // Load spread: each offer already made today costs a little, so equally
  // ranked Pros share work instead of the same one taking everything.
  const load = 1 / (1 + input.offersToday);

  return (
    proximity * 0.5 +
    input.rotationScore * 0.2 +
    input.durationFitScore * 0.1 +
    rating * 0.15 +
    load * 0.05
  );
}
