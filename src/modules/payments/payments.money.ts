/**
 * Rupees here, paise there — the one conversion in the codebase, and the only
 * place `* 100` may appear.
 *
 * Every money column in this schema is `Decimal(12,2)` in rupees and reaches
 * the application as a string (CONFLICTS_AND_DECISIONS #12). Razorpay
 * transacts exclusively in integer paise. Something has to cross that line on
 * every order, capture, refund and reconciliation.
 *
 * It is done on the **decimal string**, not on a float. `Math.round(x * 100)`
 * is how a customer gets charged ₹1234.55 for a ₹1234.56 booking: 1234.56 is
 * not representable in binary floating point, and the error is real money on
 * a real card.
 */

/** Rejects anything that is not a plain, non-negative rupee amount. */
const RUPEES = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * `'1234.56'` → `123456`.
 *
 * Accepts a `Decimal`'s string form, an integer string, or a number. A number
 * is converted via its own string form for the same reason as above — the
 * float is only ever a carrier, never an operand.
 */
export function toPaise(rupees: string | number): number {
  const raw = typeof rupees === 'number' ? rupees.toString() : rupees.trim();
  const match = RUPEES.exec(raw);

  if (!match) {
    // Deliberately an Error and not an apiError: reaching here means our own
    // code handed a malformed amount to the gateway boundary, which is a bug,
    // not something a client did. The exception filter reports it as a
    // generic 500 and logs the real cause.
    throw new Error(`Not a rupee amount: ${JSON.stringify(rupees)}`);
  }

  const [, whole, fraction = ''] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/**
 * `123456` → `'1234.56'`.
 *
 * Always two decimal places, so the result can be compared to a `Decimal`
 * column's string form and written back without a second normalisation step.
 */
export function fromPaise(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new Error(`Paise must be a whole number, got ${paise}`);
  }

  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const rupees = `${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
  return negative ? `-${rupees}` : rupees;
}

/**
 * Compares two rupee amounts exactly, by way of paise.
 *
 * `'100' === '100.00'` is false and `Number('100') === Number('100.00')` is
 * true but float-fragile. Reconciliation asks this question about every
 * captured order, so it gets one answer.
 */
export function rupeesEqual(a: string | number, b: string | number): boolean {
  return toPaise(a) === toPaise(b);
}

/** Signed difference in rupees, `a - b`. Used to report variance. */
export function rupeesDifference(
  a: string | number,
  b: string | number,
): string {
  return fromPaise(toPaise(a) - toPaise(b));
}
