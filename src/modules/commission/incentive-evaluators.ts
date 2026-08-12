import { HttpStatus } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { fromPaise, toPaise } from '../payments/payments.money';
import type { IncentiveType } from './commission.types';

/**
 * What each incentive type asks, and whether a Pro has answered it.
 *
 * Pure: criteria in, facts in, verdict out. The service derives the facts from
 * `BookingCommission` and `Review`, which is where the interesting failure
 * modes live; the arithmetic that decides whether ₹2,000 is owed lives here,
 * where a test can hold it still.
 *
 * Only two of the four types resolve. `streak` and `surge_slot` return `null`,
 * and every read of an incentive surfaces that as `hasEvaluator: false` — an
 * admin sees the gap when they create the scheme rather than a Pro discovering
 * it on payday. See the module plan, 3.6.
 */

export interface JobsCountCriteria {
  /** Completed, non-reversed jobs needed in the period. */
  target: number;
}

export interface RatingCriteria {
  /** How many rated jobs before the average means anything. */
  minJobs: number;
  /** The average that must be held, 1–5. */
  minRating: number;
}

export type ParsedCriteria = JobsCountCriteria | RatingCriteria;

/**
 * What the service measured from source rows for one Pro, one incentive, one
 * period.
 *
 * `progressValue` is the sum of contribution values and means something
 * different per type — a job count for `jobs_count`, a sum of stars for
 * `rating`. That is why `contributionCount` is carried separately: the average
 * needs both, and reconstructing one from the other is not possible.
 */
export interface EvaluationFacts {
  contributionCount: number;
  /** Decimal string. Sum of `ProIncentiveContribution.value`. */
  progressValue: string;
}

export interface EvaluationResult {
  /** The bar the Pro app draws `progressValue` against. */
  targetValue: string;
  achieved: boolean;
}

// ---------------------------------------------------------------------
// Criteria validation
// ---------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePositiveInteger(
  criteria: Record<string, unknown>,
  field: string,
): number {
  const value = criteria[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw apiError(
      'The incentive criteria are not valid for this type',
      HttpStatus.BAD_REQUEST,
      [
        {
          field: `criteriaJson.${field}`,
          message: 'Must be a whole number of 1 or more',
          code: 'INCENTIVE_CRITERIA_INVALID',
        },
      ],
    );
  }
  return value;
}

/**
 * Validate and narrow `criteriaJson` for a type.
 *
 * Called on create and on update, so a scheme is never stored in a shape its
 * own evaluator cannot read. The alternative — validating at evaluation time —
 * means the error surfaces months later, on a Pro's payday, in a background
 * job nobody is watching.
 *
 * Returns `null` for the two unevaluated types: their criteria are whatever an
 * admin wrote, because nothing will read them until somebody defines the rules.
 */
export function parseCriteria(
  incentiveType: IncentiveType,
  criteriaJson: unknown,
): ParsedCriteria | null {
  if (incentiveType === 'streak' || incentiveType === 'surge_slot') return null;

  if (!isPlainObject(criteriaJson)) {
    throw apiError(
      'The incentive criteria are not valid for this type',
      HttpStatus.BAD_REQUEST,
      [
        {
          field: 'criteriaJson',
          message: 'Must be an object',
          code: 'INCENTIVE_CRITERIA_INVALID',
        },
      ],
    );
  }

  if (incentiveType === 'jobs_count') {
    return { target: requirePositiveInteger(criteriaJson, 'target') };
  }

  const minJobs = requirePositiveInteger(criteriaJson, 'minJobs');
  const minRating = criteriaJson.minRating;
  if (
    typeof minRating !== 'number' ||
    !Number.isFinite(minRating) ||
    minRating < 1 ||
    minRating > 5
  ) {
    throw apiError(
      'The incentive criteria are not valid for this type',
      HttpStatus.BAD_REQUEST,
      [
        {
          field: 'criteriaJson.minRating',
          message: 'Must be a rating between 1 and 5',
          code: 'INCENTIVE_CRITERIA_INVALID',
        },
      ],
    );
  }

  return { minJobs, minRating };
}

// ---------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------

/**
 * Has this Pro earned the bonus?
 *
 * `null` means "this type has no evaluator" — the caller must not treat it as
 * "not yet achieved", because the two need to look completely different to an
 * admin.
 */
export function evaluate(
  incentiveType: IncentiveType,
  criteria: ParsedCriteria | null,
  facts: EvaluationFacts,
): EvaluationResult | null {
  if (criteria === null) return null;

  if (incentiveType === 'jobs_count') {
    const { target } = criteria as JobsCountCriteria;
    return {
      targetValue: fromPaise(target * 100),
      achieved: facts.contributionCount >= target,
    };
  }

  if (incentiveType === 'rating') {
    const { minJobs, minRating } = criteria as RatingCriteria;
    // The bar is the star-sum a Pro holding exactly the minimum average across
    // exactly the minimum jobs would have.
    const targetPaise = Math.round(minJobs * minRating * 100);

    // `sum >= count * minRating` is "the average is at least minRating", asked
    // without dividing — so a 4.5 threshold does not fail on a Pro sitting
    // exactly on it because 13.5/3 came back as 4.499999999999999.
    const requiredForCount = Math.round(
      facts.contributionCount * minRating * 100,
    );

    return {
      targetValue: fromPaise(targetPaise),
      achieved:
        facts.contributionCount >= minJobs &&
        toPaise(facts.progressValue) >= requiredForCount,
    };
  }

  return null;
}

/**
 * The average behind a `rating` scheme, for display. `null` when nothing has
 * been rated yet — an average of zero would read as "terrible" rather than
 * "unknown".
 */
export function averageRating(facts: EvaluationFacts): string | null {
  if (facts.contributionCount === 0) return null;
  return fromPaise(
    Math.round(toPaise(facts.progressValue) / facts.contributionCount),
  );
}
