/**
 * The vocabulary of module 8, in one place, so a status string is never a
 * bare literal in a `where` clause.
 */

/** `Service.commissionType`, mirrored onto `BookingCommission`. */
export const COMMISSION_TYPES = ['percent', 'flat'] as const;
export type CommissionType = (typeof COMMISSION_TYPES)[number];

/**
 * `BookingCommission.status`.
 *
 * - `pending` — computed at completion, inside the hold window.
 * - `approved` — the hold elapsed with no dispute. **The only state a payout
 *   batch may sweep** (US-8.9).
 * - `paid` — a disbursement *confirmed*. Never set on submission.
 * - `reversed` — terminal.
 */
export const COMMISSION_STATUSES = [
  'pending',
  'approved',
  'paid',
  'reversed',
] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

/**
 * `CommissionPayout.status`.
 *
 * `processing` exists precisely so `paid` cannot be reached by submitting a
 * request. Money is in flight; nobody is paid until RazorpayX says so.
 */
export const PAYOUT_STATUSES = [
  'draft',
  'approved',
  'processing',
  'paid',
  'failed',
  'rejected',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** `Incentive.incentiveType`. Only two of the four have evaluators. */
export const INCENTIVE_TYPES = [
  'jobs_count',
  'rating',
  'streak',
  'surge_slot',
] as const;
export type IncentiveType = (typeof INCENTIVE_TYPES)[number];

/**
 * The two types this module can actually credit.
 *
 * `streak` and `surge_slot` are configurable and deliberately inert: nobody has
 * written down what breaks a streak or what makes a slot surge, and guessing
 * either produces a payout dispute rather than a bonus. Every read of an
 * incentive reports `hasEvaluator`, so an admin sees the gap at creation
 * instead of a Pro discovering it on payday.
 */
export const EVALUATED_INCENTIVE_TYPES: readonly IncentiveType[] = [
  'jobs_count',
  'rating',
];

export function hasEvaluator(incentiveType: string): boolean {
  return EVALUATED_INCENTIVE_TYPES.includes(incentiveType as IncentiveType);
}

/**
 * `Incentive.recurrence` — how often the same scheme can be won again.
 *
 * This is the dimension that makes "complete 20 jobs → ₹2,000" answerable.
 * Without it, progress is unique per (pro, incentive) and a monthly scheme is
 * permanently locked by whoever won it first.
 */
export const INCENTIVE_RECURRENCES = [
  'once',
  'daily',
  'weekly',
  'monthly',
] as const;
export type IncentiveRecurrence = (typeof INCENTIVE_RECURRENCES)[number];

/** `PayoutDeduction.kind`. */
export const DEDUCTION_KINDS = [
  'commission_reversal',
  'incentive_unwind',
  'manual',
] as const;
export type DeductionKind = (typeof DEDUCTION_KINDS)[number];

/**
 * Exactly-once keys for the automatic deduction kinds.
 *
 * `PayoutDeduction.dedupeKey` is unique, so these two functions are the whole
 * of "the same reversal cannot deduct twice" — it is a database guarantee
 * rather than a check somebody has to remember to write.
 *
 * A manual deduction has no key: ops may legitimately raise two against the
 * same job, and Postgres treats NULLs as distinct.
 */
export function reversalDedupeKey(commissionId: string): string {
  return `commission_reversal:${commissionId}`;
}

export function incentiveUnwindDedupeKey(progressId: string): string {
  return `incentive_unwind:${progressId}`;
}

/** Settings keys this module reads. No magic numbers in the code. */
export const COMMISSION_SETTINGS = {
  /** Days in a payout batch period. */
  PAYOUT_PERIOD_DAYS: 'payout.periodDays',
  /** Net below which a payout rolls forward instead of transferring. */
  PAYOUT_MINIMUM_NET: 'payout.minimumNetAmount',
  /** How long a commission waits before it may be batched. */
  AUTO_APPROVE_AFTER_HOURS: 'commission.autoApproveAfterHours',
  /** How far back the missing-commission sweeper looks. */
  SWEEPER_LOOKBACK_HOURS: 'commission.sweeperLookbackHours',
} as const;
