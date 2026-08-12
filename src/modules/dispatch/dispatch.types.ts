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
  /**
   * The travel time proximity scores as "good". **Not a limit** — nothing is
   * excluded for exceeding it (#47). It sets the scale of the decay curve.
   */
  travelSoftTargetMinutes: number;
  assumedSpeedKmph: number;
  ratingPriorMean: number;
  ratingPriorWeight: number;
  /** How far to expand an area when looking for neighbours to widen into. */
  neighbourMarginKm: number;
  /** False keeps assignment strictly inside the booking's own area. */
  allowWidenBeyondArea: boolean;
}

/** How far the engine had to look to find a candidate. */
export const SEARCH_TIERS = ['area', 'neighbouring', 'city'] as const;
export type SearchTier = (typeof SEARCH_TIERS)[number];

/**
 * Great-circle distance in km.
 *
 * Moved to module 13, where it belongs — this module only ever held it because
 * Geo & Routing did not exist yet, as the `TravelTimePort` comment says. It is
 * re-exported here so every existing import keeps working; new callers should
 * take it from `geo/geo.types` directly.
 */
export { haversineKm } from '../geo/geo.types';

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
/**
 * Proximity as a decaying curve rather than a capped ratio.
 *
 * The old form was `1 - travel / maxTravel`, clamped at zero — which was fine
 * while anything past `maxTravel` was excluded outright. With the cap gone
 * (#47) that clamp becomes a bug: every Pro beyond the target would tie at
 * exactly 0, so a 70-minute Pro and a 200-minute Pro would rank identically
 * and the tie-break would hand the job to whichever had better rotation.
 *
 * This decays hyperbolically and **never reaches zero**, so the ordering by
 * distance survives at any range:
 *
 * ```
 *   0 min          → 1.00
 *   soft target    → 0.50
 *   2× target      → 0.33
 *   4× target      → 0.20
 * ```
 *
 * The target is a *scale*, not a limit. Doubling it does not admit anyone new
 * — nobody was being refused — it flattens the curve, making dispatch care
 * less about distance relative to rating and rotation.
 */
export function proximityScore(
  travelTimeMinutes: number,
  softTargetMinutes: number,
): number {
  const target = Math.max(1, softTargetMinutes);
  return 1 / (1 + Math.max(0, travelTimeMinutes) / target);
}

export function finalRankScore(input: {
  travelTimeMinutes: number;
  travelSoftTargetMinutes: number;
  rotationScore: number;
  durationFitScore: number;
  ratingScore: number;
  offersToday: number;
}): number {
  const proximity = proximityScore(
    input.travelTimeMinutes,
    input.travelSoftTargetMinutes,
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
