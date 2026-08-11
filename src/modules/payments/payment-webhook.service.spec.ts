import { HttpException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PaymentWebhookService } from './payment-webhook.service';

const WEBHOOK_SECRET = 'test_webhook_secret';

const sign = (body: string) =>
  createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

function buildDeps() {
  const razorpay = { webhookSecret: WEBHOOK_SECRET };
  const orders = {
    applyCapture: jest.fn(),
    applyAuthorized: jest.fn(),
    applyFailure: jest.fn(),
  };
  const refunds = {
    applyRefundInitiated: jest.fn(),
    applyRefundSettled: jest.fn(),
    applyRefundFailed: jest.fn(),
  };
  const redis = { setIfAbsent: jest.fn().mockResolvedValue(true) };
  const settings = { getNumber: jest.fn().mockResolvedValue(7) };
  return { razorpay, orders, refunds, redis, settings };
}

function build(deps: ReturnType<typeof buildDeps>): PaymentWebhookService {
  return new PaymentWebhookService(
    deps.razorpay as never,
    deps.orders as never,
    deps.refunds as never,
    deps.redis as never,
    deps.settings as never,
  );
}

const capturedBody = JSON.stringify({
  event: 'payment.captured',
  payload: {
    payment: {
      entity: {
        id: 'pay_XYZ',
        order_id: 'order_ABC',
        amount: 59900,
        status: 'captured',
        method: 'upi',
      },
    },
  },
});

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    throw new Error('expected a rejection');
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe('PaymentWebhookService · authentication', () => {
  it('rejects a delivery whose signature does not verify', async () => {
    const deps = buildDeps();

    const status = await statusOf(
      build(deps).handle({ rawBody: capturedBody, signature: 'f'.repeat(64) }),
    );

    expect(status).toBe(401);
    expect(deps.orders.applyCapture).not.toHaveBeenCalled();
  });

  /**
   * `rawBody: true` was lost from main.ts. Failing loudly beats verifying
   * against a re-serialised body, which rejects genuine deliveries for reasons
   * nobody can reproduce.
   */
  it('rejects rather than guessing when the raw body is missing', async () => {
    const deps = buildDeps();

    expect(
      await statusOf(
        build(deps).handle({
          rawBody: undefined,
          signature: sign(capturedBody),
        }),
      ),
    ).toBe(401);
  });

  it('accepts a correctly signed delivery', async () => {
    const deps = buildDeps();

    const result = await build(deps).handle({
      rawBody: capturedBody,
      signature: sign(capturedBody),
    });

    expect(result.outcome).toBe('processed');
    expect(deps.orders.applyCapture).toHaveBeenCalledWith({
      razorpayOrderId: 'order_ABC',
      razorpayPaymentId: 'pay_XYZ',
      amountPaise: 59900,
      method: 'upi',
    });
  });
});

describe('PaymentWebhookService · idempotency', () => {
  it('short-circuits a redelivery it has already seen', async () => {
    const deps = buildDeps();
    deps.redis.setIfAbsent.mockResolvedValue(false);

    const result = await build(deps).handle({
      rawBody: capturedBody,
      signature: sign(capturedBody),
    });

    expect(result.outcome).toBe('duplicate');
    expect(deps.orders.applyCapture).not.toHaveBeenCalled();
  });

  /**
   * Correctness rests on convergent writes, not on Redis. Processing twice is
   * safe; not processing leaves a paid booking undispatched.
   */
  it('processes anyway when Redis is unreachable', async () => {
    const deps = buildDeps();
    deps.redis.setIfAbsent.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await build(deps).handle({
      rawBody: capturedBody,
      signature: sign(capturedBody),
    });

    expect(result.outcome).toBe('processed');
    expect(deps.orders.applyCapture).toHaveBeenCalled();
  });
});

describe('PaymentWebhookService · the retry contract', () => {
  /**
   * Razorpay retries a non-2xx for 24 hours. Retrying our own bug runs it 40
   * more times without fixing it; reconciliation is what finds what we dropped.
   */
  it('does not throw when processing fails, so Razorpay does not retry a bug', async () => {
    const deps = buildDeps();
    deps.orders.applyCapture.mockRejectedValue(
      new Error('column does not exist'),
    );

    const result = await build(deps).handle({
      rawBody: capturedBody,
      signature: sign(capturedBody),
    });

    expect(result.outcome).toBe('failed');
  });

  /**
   * Enabling an extra event in the Razorpay dashboard is an ops action with no
   * deploy behind it. It must not start failing deliveries.
   */
  it('acknowledges an event it does not handle', async () => {
    const deps = buildDeps();
    const body = JSON.stringify({ event: 'order.paid', payload: {} });

    const result = await build(deps).handle({
      rawBody: body,
      signature: sign(body),
    });

    expect(result.outcome).toBe('ignored');
  });

  it('acknowledges a verified body that is not JSON at all', async () => {
    const deps = buildDeps();

    const result = await build(deps).handle({
      rawBody: 'not json',
      signature: sign('not json'),
    });

    expect(result.outcome).toBe('ignored');
  });
});

describe('PaymentWebhookService · routing', () => {
  it('routes payment.authorized without capturing', async () => {
    const deps = buildDeps();
    const body = JSON.stringify({
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'p', order_id: 'o', amount: 1 } } },
    });

    await build(deps).handle({ rawBody: body, signature: sign(body) });

    expect(deps.orders.applyAuthorized).toHaveBeenCalled();
    expect(deps.orders.applyCapture).not.toHaveBeenCalled();
  });

  it('routes payment.failed with its failure code', async () => {
    const deps = buildDeps();
    const body = JSON.stringify({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'p',
            order_id: 'o',
            amount: 1,
            error_code: 'BAD_REQUEST_ERROR',
          },
        },
      },
    });

    await build(deps).handle({ rawBody: body, signature: sign(body) });

    expect(deps.orders.applyFailure).toHaveBeenCalledWith({
      razorpayOrderId: 'o',
      failureCode: 'BAD_REQUEST_ERROR',
    });
  });

  it('routes refund.processed, which is what settles a refund days later', async () => {
    const deps = buildDeps();
    const body = JSON.stringify({
      event: 'refund.processed',
      payload: {
        refund: {
          entity: { id: 'rfnd_1', payment_id: 'pay_XYZ', amount: 59900 },
        },
      },
    });

    await build(deps).handle({ rawBody: body, signature: sign(body) });

    expect(deps.refunds.applyRefundSettled).toHaveBeenCalledWith({
      razorpayRefundId: 'rfnd_1',
      razorpayPaymentId: 'pay_XYZ',
      amountPaise: 59900,
    });
  });

  it('ignores a payment event with no order to attach it to', async () => {
    const deps = buildDeps();
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'p', order_id: null, amount: 1 } } },
    });

    const result = await build(deps).handle({
      rawBody: body,
      signature: sign(body),
    });

    expect(result.outcome).toBe('processed');
    expect(deps.orders.applyCapture).not.toHaveBeenCalled();
  });
});
