type Env = Record<string, string | undefined>;

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  /** Separate from the key secret. Razorpay signs webhooks with this one. */
  webhookSecret: string;
  baseUrl: string;
}

/**
 * Unlike `buildRedisOptions` and `buildS3Options`, this one **returns
 * `undefined` rather than throwing** when the credentials are absent.
 *
 * That difference is deliberate. Redis and S3 are needed by every path, so a
 * missing config is a broken deployment and should fail at boot. Razorpay is
 * needed only by `paymentMode = online` — and `cash` is the default, has no
 * gateway at all, and runs the entire booking lifecycle end to end without it.
 * Throwing here would mean a developer with no gateway keys could not run the
 * product, which is a worse failure than the honest 501 an online booking
 * already returns when no implementation is registered.
 *
 * Both secrets are required together with the key id. A half-configured
 * gateway is worse than an unconfigured one: order creation would work and
 * webhook verification would reject every delivery, leaving paid bookings
 * stuck in `awaiting_payment` with money taken.
 */
export function buildRazorpayOptions(
  env: Env = process.env,
): RazorpayOptions | undefined {
  const keyId = str(env.RAZORPAY_KEY_ID);
  const keySecret = str(env.RAZORPAY_KEY_SECRET);
  const webhookSecret = str(env.RAZORPAY_WEBHOOK_SECRET);

  if (!keyId && !keySecret && !webhookSecret) return undefined;

  if (!keyId || !keySecret || !webhookSecret) {
    throw new Error(
      'Razorpay is half-configured. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET ' +
        `and RAZORPAY_WEBHOOK_SECRET together in .env.${env.NODE_ENV ?? 'local'}, ` +
        'or none of them to run cash-only.',
    );
  }

  return {
    keyId,
    keySecret,
    webhookSecret,
    baseUrl: str(env.RAZORPAY_BASE_URL) ?? 'https://api.razorpay.com/v1',
  };
}
