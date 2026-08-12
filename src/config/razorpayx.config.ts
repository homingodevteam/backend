type Env = Record<string, string | undefined>;

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface RazorpayXOptions {
  keyId: string;
  keySecret: string;
  /** Signs payout webhooks. Separate from the key secret, as with Razorpay. */
  webhookSecret: string;
  /**
   * The current account money leaves from. RazorpayX will not accept a payout
   * without it, and it is **not** derivable from the key — which is why a
   * half-configured deployment is refused below rather than discovered at the
   * first transfer.
   */
  accountNumber: string;
  baseUrl: string;
}

/**
 * RazorpayX is a **different product** from module 7's Razorpay.
 *
 * Different dashboard, different credentials, different semantics: Razorpay
 * pulls money in from customers, RazorpayX pushes it out from a current
 * account. Module 7's `RazorpayClient` cannot be pointed at it, and reusing its
 * credentials would fail authentication in a way that reads like an outage.
 *
 * Returns `undefined` rather than throwing when nothing is set, for the same
 * reason `buildRazorpayOptions` does: a developer with no payout credentials
 * must still be able to run the product. Everything in module 8 except the
 * transfer itself works without this — commissions compute, incentives credit,
 * batches generate, finance approves. Only `disburse` reports, honestly, that
 * it cannot move money.
 *
 * All four values are required together. A half-configured payout rail is worse
 * than none: transfers would be submitted and every webhook confirming them
 * rejected, leaving Pros recorded as `processing` forever with money that has
 * actually left the account.
 */
export function buildRazorpayXOptions(
  env: Env = process.env,
): RazorpayXOptions | undefined {
  const keyId = str(env.RAZORPAYX_KEY_ID);
  const keySecret = str(env.RAZORPAYX_KEY_SECRET);
  const webhookSecret = str(env.RAZORPAYX_WEBHOOK_SECRET);
  const accountNumber = str(env.RAZORPAYX_ACCOUNT_NUMBER);

  if (!keyId && !keySecret && !webhookSecret && !accountNumber)
    return undefined;

  if (!keyId || !keySecret || !webhookSecret || !accountNumber) {
    throw new Error(
      'RazorpayX is half-configured. Set RAZORPAYX_KEY_ID, ' +
        'RAZORPAYX_KEY_SECRET, RAZORPAYX_WEBHOOK_SECRET and ' +
        `RAZORPAYX_ACCOUNT_NUMBER together in .env.${env.NODE_ENV ?? 'local'}, ` +
        'or none of them to run without payouts.',
    );
  }

  return {
    keyId,
    keySecret,
    webhookSecret,
    accountNumber,
    baseUrl: str(env.RAZORPAYX_BASE_URL) ?? 'https://api.razorpay.com/v1',
  };
}
