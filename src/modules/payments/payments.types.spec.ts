import {
  advanceRefundStatus,
  advanceStatus,
  isForwardStatus,
  isHandledEvent,
} from './payments.types';

describe('advanceStatus', () => {
  it('moves an order forward', () => {
    expect(advanceStatus('created', 'attempted')).toBe('attempted');
    expect(advanceStatus('attempted', 'paid')).toBe('paid');
  });

  /**
   * The failure this exists to prevent: Razorpay delivers `payment.captured`
   * before `payment.authorized` often enough that treating each write as an
   * assignment would leave genuinely paid bookings at `attempted` — money
   * taken, nothing dispatched.
   */
  it('ignores a late authorized arriving after a capture', () => {
    expect(advanceStatus('paid', 'attempted')).toBe('paid');
  });

  it('is idempotent, so a redelivery changes nothing', () => {
    expect(advanceStatus('paid', 'paid')).toBe('paid');
    expect(advanceStatus('created', 'created')).toBe('created');
  });

  it('never returns to created', () => {
    expect(advanceStatus('attempted', 'created')).toBe('attempted');
    expect(advanceStatus('paid', 'created')).toBe('paid');
  });
});

describe('isForwardStatus', () => {
  it('is what the capture writer branches on to run its side effects once', () => {
    expect(isForwardStatus('attempted', 'paid')).toBe(true);
    expect(isForwardStatus('paid', 'paid')).toBe(false);
    expect(isForwardStatus('paid', 'attempted')).toBe(false);
  });
});

describe('advanceRefundStatus', () => {
  it('walks initiated to settled — the two states the customer must distinguish', () => {
    expect(advanceRefundStatus('none', 'initiated')).toBe('initiated');
    expect(advanceRefundStatus('initiated', 'settled')).toBe('settled');
  });

  it('records a failure after initiation, which must stay visible', () => {
    expect(advanceRefundStatus('initiated', 'failed')).toBe('failed');
  });

  it('refuses to un-settle money that already landed', () => {
    expect(advanceRefundStatus('settled', 'failed')).toBe('settled');
  });

  it('ignores a duplicate refund.processed', () => {
    expect(advanceRefundStatus('settled', 'settled')).toBe('settled');
    expect(advanceRefundStatus('settled', 'initiated')).toBe('settled');
  });
});

describe('isHandledEvent', () => {
  it('recognises the six events this module acts on', () => {
    expect(isHandledEvent('payment.captured')).toBe(true);
    expect(isHandledEvent('refund.processed')).toBe(true);
  });

  /**
   * Enabling an extra event in the Razorpay dashboard is an ops action with
   * no deploy behind it. It must not start failing deliveries.
   */
  it('does not recognise events we deliberately ignore', () => {
    expect(isHandledEvent('order.paid')).toBe(false);
    expect(isHandledEvent('payment.dispute.created')).toBe(false);
  });
});
