import type { IncentiveRecurrence } from './commission.types';

/**
 * Turning "when did this job happen" into "which run of this scheme does it
 * count toward".
 *
 * Pure, and deliberately free of any clock: every function takes the instant it
 * is reasoning about, so a test can pin a month boundary without mocking time.
 *
 * **Everything here is Asia/Kolkata.** A payout period and an incentive month
 * are things a person in Indore experiences, not things UTC experiences — a job
 * finished at 3 a.m. on 1 September IST happened in September, and computing the
 * boundary in UTC would file it under August for five and a half hours every
 * month. IST has no daylight saving and a fixed +05:30 offset, so the shift is
 * a constant rather than a timezone library.
 */

/** +05:30 in milliseconds. Fixed for all time; India has no DST. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export interface IncentivePeriod {
  /** `lifetime`, `2026-08`, `2026-W33` or `2026-08-12`. */
  key: string;
  /** Inclusive lower bound, as a UTC instant. */
  start: Date;
  /** Exclusive upper bound, as a UTC instant. */
  end: Date;
}

/** The wall-clock date in India for a given instant. */
function istParts(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Midnight IST on a given Indian calendar date, as a UTC instant. */
function istMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * ISO-8601 week number of an Indian calendar date.
 *
 * Weeks run Monday to Sunday and belong to whichever year holds their Thursday,
 * which is why 1 January is sometimes week 52 of the year before. Getting that
 * wrong would not break anything visibly — it would just quietly file a
 * new-year job under the previous week and let a Pro win the same weekly bonus
 * twice.
 */
function isoWeek(
  year: number,
  month: number,
  day: number,
): {
  weekYear: number;
  week: number;
} {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Monday = 0 … Sunday = 6.
  const dayOfWeek = (date.getUTCDay() + 6) % 7;
  // Step to the Thursday of this week; its year is the week's year.
  date.setUTCDate(date.getUTCDate() - dayOfWeek + 3);
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);
  const week =
    1 + Math.round((date.getTime() - firstThursday.getTime()) / 604_800_000);
  return { weekYear, week };
}

/**
 * The window `at` falls into for a scheme with this recurrence.
 *
 * `once` returns the whole of time under the key `lifetime`. That is what makes
 * a one-shot scheme genuinely one-shot: every job maps to the same period row,
 * and the unique key on (pro, incentive, periodKey) does the rest.
 */
export function periodFor(
  recurrence: IncentiveRecurrence,
  at: Date,
): IncentivePeriod {
  const { year, month, day } = istParts(at);

  switch (recurrence) {
    case 'daily':
      return {
        key: `${year}-${pad(month)}-${pad(day)}`,
        start: istMidnight(year, month, day),
        end: istMidnight(year, month, day + 1),
      };

    case 'weekly': {
      const { weekYear, week } = isoWeek(year, month, day);
      // Back up to Monday of this Indian week.
      const dayOfWeek =
        (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
      return {
        key: `${weekYear}-W${pad(week)}`,
        start: istMidnight(year, month, day - dayOfWeek),
        end: istMidnight(year, month, day - dayOfWeek + 7),
      };
    }

    case 'monthly':
      return {
        key: `${year}-${pad(month)}`,
        start: istMidnight(year, month, 1),
        end: istMidnight(year, month + 1, 1),
      };

    case 'once':
    default:
      return {
        key: 'lifetime',
        // Bounds a query can still use without a special case for null.
        start: new Date(0),
        end: new Date('9999-12-31T00:00:00.000Z'),
      };
  }
}

/**
 * The batch window ending at `periodEnd`, `periodDays` long.
 *
 * Payout periods are labels, not filters — what a batch actually sweeps is
 * every approved unpaid commission as of `periodEnd`, which is what keeps a
 * late-approved job from being orphaned by every later batch. See
 * `payout-batch.service.ts`.
 */
export function payoutPeriod(
  periodEnd: Date,
  periodDays: number,
): { start: Date; end: Date } {
  const { year, month, day } = istParts(periodEnd);
  const end = istMidnight(year, month, day + 1);
  const start = istMidnight(year, month, day - (periodDays - 1));
  return { start, end };
}

/** Start of the Indian day containing `at`. Powers "what did I earn today". */
export function startOfIstDay(at: Date): Date {
  const { year, month, day } = istParts(at);
  return istMidnight(year, month, day);
}
