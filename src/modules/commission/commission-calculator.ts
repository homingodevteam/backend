import { fromPaise, toPaise } from '../payments/payments.money';
import type { CommissionType } from './commission.types';

/**
 * The whole of what a Pro earns from a job, as pure arithmetic.
 *
 * Deliberately a module of free functions with no Prisma, no Nest and no
 * clock: this is the one piece of module 8 that must be provable by reading
 * it, and every interesting rule below is a rule about money that a test can
 * pin exactly. The service layer decides *when* to call it and what to persist.
 *
 * **Paise throughout.** Rupee decimal strings come in and go out, and every
 * operand in between is an integer, for the reason `payments.money.ts` already
 * documents: `Math.round(price * rate)` on floats is how somebody gets paid
 * ₹299.99 instead of ₹300.00, repeatedly, for months.
 */

export interface CommissionRate {
  commissionType: CommissionType;
  /** Percentage points when `percent`; rupees when `flat`. Decimal string. */
  commissionValue: string;
}

export interface CommissionShares {
  /** What the **Pro earns**. Rupee string, two decimals. */
  commissionAmount: string;
  /** `customerFlatAmount - commissionAmount`. Never negative. */
  platformAmount: string;
  /**
   * True when a `flat` rate exceeded the job price and was clamped.
   *
   * Not an error here — refusing to compute would leave a finished job unpaid
   * over a configuration mistake — but the caller must log it loudly, because
   * it means the platform earned nothing on the job and somebody typed the
   * wrong number into the catalogue.
   */
  capped: boolean;
}

/**
 * Exact half-up division of two integers, without ever touching a float.
 *
 * `Math.round(n / d)` is close enough for most things and not for this: the
 * quotient is inexact before `round` ever sees it, so a value sitting exactly
 * on a half-paise boundary rounds whichever way the binary representation
 * happened to fall. Comparing the doubled remainder against the divisor asks
 * the question in integers, where there is no boundary to fall off.
 */
function divideRoundHalfUp(numerator: number, divisor: number): number {
  const quotient = Math.floor(numerator / divisor);
  const remainder = numerator - quotient * divisor;
  return remainder * 2 >= divisor ? quotient + 1 : quotient;
}

/**
 * Split a job's price between the Pro and the platform.
 *
 * **`actualDurationMinutes` is not a parameter, and that is the point.** One
 * flat rate per service: a four-hour job pays exactly what a one-hour one does
 * (CONFLICTS_AND_DECISIONS #18). There is nowhere in this signature to pass a
 * duration, so no future edit can quietly start reading one.
 *
 * The percentage is taken against **`Booking.flatPrice`** — the price frozen
 * onto the booking at creation — not against the service's price today. The
 * caller passes it in; this function has no way to reach the catalogue.
 */
export function computeShares(input: {
  flatPrice: string;
  rate: CommissionRate;
}): CommissionShares {
  const pricePaise = toPaise(input.flatPrice);
  const { commissionType, commissionValue } = input.rate;

  let proPaise: number;

  if (commissionType === 'percent') {
    // `commissionValue` is percentage points with two decimals, so its paise
    // form is hundredths of a percent: '30.00' -> 3000. Multiplying by the
    // price and dividing by 10 000 gives paise, in integers the whole way.
    const hundredthsOfPercent = toPaise(commissionValue);
    proPaise = divideRoundHalfUp(pricePaise * hundredthsOfPercent, 10_000);
  } else {
    proPaise = toPaise(commissionValue);
  }

  // A flat rate above the price, or a percentage above 100, would make the
  // platform's share negative — an amount that cannot be reported, refunded or
  // reconciled. Clamp and let the caller shout.
  const capped = proPaise > pricePaise;
  if (capped) proPaise = pricePaise;

  return {
    commissionAmount: fromPaise(proPaise),
    platformAmount: fromPaise(pricePaise - proPaise),
    capped,
  };
}

/**
 * The per-job figure the Pro sees on that job's row.
 *
 * **Not what the payout is built from.** A payout sums `commissionAmount` and
 * `incentiveAmount` across rows and takes deductions from `PayoutDeduction`,
 * which is the only place a deduction is actually consumed. Summing
 * `netPayable` as well would subtract every deduction twice — once here for
 * display, once there for real. See `payout-batch.service.ts`.
 *
 * Floored at zero: a per-job deduction larger than the job's pay does not make
 * the job owe money. The unconsumed remainder lives on the deduction row and
 * is carried forward by the batch.
 */
export function computeNetPayable(input: {
  commissionAmount: string;
  incentiveAmount: string;
  deductionAmount: string;
}): string {
  const net =
    toPaise(input.commissionAmount) +
    toPaise(input.incentiveAmount) -
    toPaise(input.deductionAmount);
  return fromPaise(Math.max(0, net));
}

/** Sum of rupee strings, exactly. `[]` is `'0.00'`. */
export function sumRupees(amounts: readonly string[]): string {
  return fromPaise(amounts.reduce((total, next) => total + toPaise(next), 0));
}

/**
 * How much of `owed` can be taken out of `available`, and what is left.
 *
 * Consumption is **partial**, which is the difference between a deduction that
 * eventually settles and one that either overdraws a payout or is silently
 * written off. A ₹5,000 recovery against a ₹2,000 period takes ₹2,000 now and
 * waits for ₹3,000 — the payout lands at zero, never below it.
 */
export function consumeAgainst(
  available: string,
  owed: string,
): { taken: string; remainingOwed: string; remainingAvailable: string } {
  const availablePaise = toPaise(available);
  const owedPaise = toPaise(owed);
  const takenPaise = Math.min(availablePaise, owedPaise);

  return {
    taken: fromPaise(takenPaise),
    remainingOwed: fromPaise(owedPaise - takenPaise),
    remainingAvailable: fromPaise(availablePaise - takenPaise),
  };
}
