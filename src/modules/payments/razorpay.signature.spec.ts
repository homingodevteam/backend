import { createHmac } from 'node:crypto';
import {
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from './razorpay.signature';

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('hex');

describe('verifyCheckoutSignature', () => {
  const order = 'order_ABC123';
  const payment = 'pay_XYZ789';

  it('accepts the signature Razorpay produces over order|payment', () => {
    expect(
      verifyCheckoutSignature({
        razorpayOrderId: order,
        razorpayPaymentId: payment,
        signature: sign(`${order}|${payment}`, KEY_SECRET),
        keySecret: KEY_SECRET,
      }),
    ).toBe(true);
  });

  it('rejects a signature made with the webhook secret', () => {
    expect(
      verifyCheckoutSignature({
        razorpayOrderId: order,
        razorpayPaymentId: payment,
        signature: sign(`${order}|${payment}`, WEBHOOK_SECRET),
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  /**
   * The attack this closes: a client that legitimately paid order A tries to
   * mark order B paid by reusing its own valid signature.
   */
  it('rejects a valid signature replayed against a different order', () => {
    const signature = sign(`${order}|${payment}`, KEY_SECRET);
    expect(
      verifyCheckoutSignature({
        razorpayOrderId: 'order_SOMEONE_ELSE',
        razorpayPaymentId: payment,
        signature,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['deadbeef', 'truncated'],
    ['zz'.repeat(32), 'non-hex'],
  ])('rejects a %s signature without throwing', (signature) => {
    expect(
      verifyCheckoutSignature({
        razorpayOrderId: order,
        razorpayPaymentId: payment,
        signature,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });
});

describe('verifyWebhookSignature', () => {
  const body =
    '{"event":"payment.captured","payload":{"payment":{"id":"pay_1"}}}';

  it('accepts a delivery signed with the webhook secret', () => {
    expect(
      verifyWebhookSignature({
        rawBody: body,
        signature: sign(body, WEBHOOK_SECRET),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(true);
  });

  it('verifies over bytes, so a Buffer and its string are the same delivery', () => {
    expect(
      verifyWebhookSignature({
        rawBody: Buffer.from(body, 'utf8'),
        signature: sign(body, WEBHOOK_SECRET),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(true);
  });

  /**
   * The whole reason `main.ts` enables rawBody. These two bodies are the same
   * JSON *value* and different *bytes*; anything that verified against a
   * re-serialised body would pass here and fail against a real delivery
   * whenever Razorpay's key order differed from V8's.
   */
  it('fails when the body is re-serialised with different key order', () => {
    const signature = sign(body, WEBHOOK_SECRET);
    const reSerialised = JSON.stringify(JSON.parse(body), ['payload', 'event']);

    expect(reSerialised).not.toBe(body);
    expect(
      verifyWebhookSignature({
        rawBody: reSerialised,
        signature,
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(false);
  });

  it('fails when a single byte of the body is altered', () => {
    const signature = sign(body, WEBHOOK_SECRET);
    expect(
      verifyWebhookSignature({
        rawBody: body.replace('pay_1', 'pay_2'),
        signature,
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(false);
  });

  it('rejects a body signed with the API key secret', () => {
    expect(
      verifyWebhookSignature({
        rawBody: body,
        signature: sign(body, KEY_SECRET),
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(false);
  });

  it('rejects a missing signature header without throwing', () => {
    expect(
      verifyWebhookSignature({
        rawBody: body,
        signature: '',
        webhookSecret: WEBHOOK_SECRET,
      }),
    ).toBe(false);
  });
});
