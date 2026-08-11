import { HttpException } from '@nestjs/common';
import { RefundsService } from './refunds.service';

function buildDeps() {
  const prisma = {
    order: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    booking: { update: jest.fn() },
  };
  const razorpay = { createRefund: jest.fn() };
  const ledger = { recordRefund: jest.fn() };
  return { prisma, razorpay, ledger };
}

function build(deps: ReturnType<typeof buildDeps>): RefundsService {
  return new RefundsService(
    deps.prisma as never,
    deps.razorpay as never,
    deps.ledger as never,
  );
}

const decimal = (value: string) => ({ toString: () => value });

function aPaidOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-row-1',
    bookingId: 'bk-1',
    customerId: 'cust-1',
    status: 'paid',
    capturedPaymentId: 'pay_XYZ',
    amount: decimal('599.00'),
    amountPaid: decimal('599.00'),
    refundAmount: null,
    razorpayRefundId: null,
    refundStatus: 'none',
    refundedAt: null,
    ...overrides,
  };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    throw new Error('expected a rejection');
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe('RefundsService · initiate', () => {
  /**
   * Feature 8. The call returns in a second; the money lands 5–7 working days
   * later. A customer told only "refunded" on day one phones on day three.
   */
  it('lands on `initiated`, not `settled`', async () => {
    const deps = buildDeps();
    deps.prisma.order.findFirst.mockResolvedValue(aPaidOrder());
    deps.razorpay.createRefund.mockResolvedValue({ id: 'rfnd_1' });
    deps.prisma.order.update.mockResolvedValue(
      aPaidOrder({ refundStatus: 'initiated' }),
    );

    await build(deps).initiate({ bookingId: 'bk-1' });

    expect(deps.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refundStatus: 'initiated' }),
      }),
    );
  });

  it('omits the amount for a full refund, which is Razorpay’s own convention', async () => {
    const deps = buildDeps();
    deps.prisma.order.findFirst.mockResolvedValue(aPaidOrder());
    deps.razorpay.createRefund.mockResolvedValue({ id: 'rfnd_1' });
    deps.prisma.order.update.mockResolvedValue(aPaidOrder());

    await build(deps).initiate({ bookingId: 'bk-1' });

    expect(deps.razorpay.createRefund).toHaveBeenCalledWith(
      expect.not.objectContaining({ amountPaise: expect.anything() }),
    );
  });

  it('sends a partial refund in paise', async () => {
    const deps = buildDeps();
    deps.prisma.order.findFirst.mockResolvedValue(aPaidOrder());
    deps.razorpay.createRefund.mockResolvedValue({ id: 'rfnd_1' });
    deps.prisma.order.update.mockResolvedValue(aPaidOrder());

    await build(deps).initiate({ bookingId: 'bk-1', amount: '299.50' });

    expect(deps.razorpay.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 29950 }),
    );
  });

  /** Cumulative, never per-refund — otherwise the second looks like the only one. */
  it('accumulates across partial refunds', async () => {
    const deps = buildDeps();
    deps.prisma.order.findFirst.mockResolvedValue(
      aPaidOrder({ refundAmount: decimal('200.00'), refundStatus: 'settled' }),
    );
    deps.razorpay.createRefund.mockResolvedValue({ id: 'rfnd_2' });
    deps.prisma.order.update.mockResolvedValue(aPaidOrder());

    await build(deps).initiate({ bookingId: 'bk-1', amount: '100.00' });

    expect(deps.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refundAmount: '300.00' }),
      }),
    );
  });

  it('refuses to refund more than remains', async () => {
    const deps = buildDeps();
    deps.prisma.order.findFirst.mockResolvedValue(
      aPaidOrder({ refundAmount: decimal('500.00') }),
    );

    expect(
      await statusOf(
        build(deps).initiate({ bookingId: 'bk-1', amount: '200.00' }),
      ),
    ).toBe(409);
    expect(deps.razorpay.createRefund).not.toHaveBeenCalled();
  });

  it('refuses a second full refund', async () => {
    const deps = buildDeps();
    deps.prisma.order.findFirst.mockResolvedValue(
      aPaidOrder({ refundAmount: decimal('599.00') }),
    );

    expect(await statusOf(build(deps).initiate({ bookingId: 'bk-1' }))).toBe(
      409,
    );
  });

  /** The most likely real cause, and worth naming in the error. */
  it('explains that a cash booking has no gateway payment to refund', async () => {
    const deps = buildDeps();
    deps.prisma.order.findFirst.mockResolvedValue(null);

    expect(await statusOf(build(deps).initiate({ bookingId: 'bk-1' }))).toBe(
      409,
    );
  });

  it('does not record a refund when the gateway refuses the call', async () => {
    const deps = buildDeps();
    deps.prisma.order.findFirst.mockResolvedValue(aPaidOrder());
    deps.razorpay.createRefund.mockRejectedValue(new Error('gateway down'));

    expect(await statusOf(build(deps).initiate({ bookingId: 'bk-1' }))).toBe(
      503,
    );
    expect(deps.prisma.order.update).not.toHaveBeenCalled();
  });
});

describe('RefundsService · settlement', () => {
  it('marks the booking refunded only on a full refund', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(
      aPaidOrder({ refundStatus: 'initiated' }),
    );
    deps.prisma.order.update.mockResolvedValue(
      aPaidOrder({ refundStatus: 'settled', refundAmount: decimal('599.00') }),
    );

    await build(deps).applyRefundSettled({
      razorpayRefundId: 'rfnd_1',
      razorpayPaymentId: 'pay_XYZ',
      amountPaise: 59900,
    });

    expect(deps.prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'bk-1' },
      data: { paymentStatus: 'refunded' },
    });
  });

  /**
   * A partial refund leaves the booking `paid`, which is still true — the
   * platform kept part of that money. `refunded` beside a retained
   * cancellation fee would misstate what happened.
   */
  it('leaves a partly refunded booking as paid', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(
      aPaidOrder({ refundStatus: 'initiated' }),
    );
    deps.prisma.order.update.mockResolvedValue(
      aPaidOrder({ refundStatus: 'settled', refundAmount: decimal('200.00') }),
    );

    await build(deps).applyRefundSettled({
      razorpayRefundId: 'rfnd_1',
      razorpayPaymentId: 'pay_XYZ',
      amountPaise: 20000,
    });

    expect(deps.prisma.booking.update).not.toHaveBeenCalled();
  });

  it('keeps refundedAt from the row on a redelivery', async () => {
    const deps = buildDeps();
    const settledAt = new Date('2026-08-11T10:00:00Z');
    deps.prisma.order.findUnique.mockResolvedValue(
      aPaidOrder({ refundStatus: 'settled', refundedAt: settledAt }),
    );
    deps.prisma.order.update.mockResolvedValue(
      aPaidOrder({ refundStatus: 'settled' }),
    );

    await build(deps).applyRefundSettled({
      razorpayRefundId: 'rfnd_1',
      razorpayPaymentId: 'pay_XYZ',
      amountPaise: 59900,
    });

    expect(deps.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refundedAt: settledAt }),
      }),
    );
  });
});

describe('RefundsService · failure', () => {
  /**
   * Zeroing `refundAmount` would make the order look untouched, hiding money
   * the platform still owes.
   */
  it('records the failure and leaves the amount standing', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(
      aPaidOrder({
        refundStatus: 'initiated',
        refundAmount: decimal('599.00'),
      }),
    );
    deps.prisma.order.update.mockResolvedValue(
      aPaidOrder({ refundStatus: 'failed' }),
    );

    await build(deps).applyRefundFailed('rfnd_1', 'pay_XYZ');

    const written = deps.prisma.order.update.mock.calls[0][0].data;
    expect(written).toEqual({ refundStatus: 'failed' });
  });

  it('refuses to un-settle a refund that already landed', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(
      aPaidOrder({ refundStatus: 'settled' }),
    );
    deps.prisma.order.update.mockResolvedValue(
      aPaidOrder({ refundStatus: 'settled' }),
    );

    await build(deps).applyRefundFailed('rfnd_1', 'pay_XYZ');

    expect(deps.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refundStatus: 'settled' } }),
    );
  });

  it('ignores a refund event for a payment that is not ours', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(null);

    await build(deps).applyRefundFailed('rfnd_1', 'pay_UNKNOWN');

    expect(deps.prisma.order.update).not.toHaveBeenCalled();
  });
});
