import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The two HMACs Razorpay signs with, and the only place either is checked.
 *
 * Both are SHA-256 over a payload we must reproduce **byte for byte**. They
 * differ in what that payload is and which secret keys it:
 *
 * | Signature      | Payload                    | Secret          |
 * | -------------- | -------------------------- | --------------- |
 * | Checkout       | `<order_id>|<payment_id>`  | API key secret  |
 * | Webhook        | the raw request body       | webhook secret  |
 *
 * Using the wrong secret for either is a silent failure that looks like an
 * attack — every delivery rejected, no obvious cause — which is why
 * `buildRazorpayOptions` refuses to start with only one of them set.
 */

/**
 * Constant-time comparison of two hex digests.
 *
 * `a === b` on a string leaks how many leading characters matched through
 * timing, which over enough attempts recovers a valid signature one nibble at
 * a time. `timingSafeEqual` throws on a length mismatch, so that is checked
 * first — and a length mismatch reveals nothing an attacker did not already
 * know, since the digest length is fixed by the algorithm.
 */
function digestsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function hmacHex(payload: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verifies the signature Checkout hands back to the client.
 *
 * **A true return does not mean the payment succeeded.** It means Razorpay
 * produced this `order_id | payment_id` pair — nothing about its status, its
 * amount, or whether it was captured. It is also replayable by whoever
 * legitimately received it. The caller must still fetch the payment from the
 * gateway and assert what it actually is; see `orders.service.ts`.
 */
export function verifyCheckoutSignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  const expected = hmacHex(
    `${input.razorpayOrderId}|${input.razorpayPaymentId}`,
    input.keySecret,
  );
  return digestsMatch(expected, input.signature);
}

/**
 * Verifies a webhook delivery against the raw request body.
 *
 * The body must be the **exact bytes** Razorpay sent. A parse-then-stringify
 * round trip does not preserve key order, unicode escaping or whitespace, so
 * verifying against a re-serialised body fails intermittently and
 * unreproducibly — the worst possible failure mode for money. This is why
 * `main.ts` enables `rawBody` (CONFLICTS_AND_DECISIONS #38).
 */
export function verifyWebhookSignature(input: {
  rawBody: Buffer | string;
  signature: string;
  webhookSecret: string;
}): boolean {
  const expected = hmacHex(input.rawBody, input.webhookSecret);
  return digestsMatch(expected, input.signature);
}
