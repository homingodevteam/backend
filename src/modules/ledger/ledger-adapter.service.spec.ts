import { LedgerAdapterService } from './ledger-adapter.service';

function buildDeps() {
  const ledger = { append: jest.fn().mockResolvedValue({ id: 'entry-1' }) };
  return { ledger };
}

function build(deps: ReturnType<typeof buildDeps>): LedgerAdapterService {
  return new LedgerAdapterService(deps.ledger as never);
}

/** The one call the adapter made, as `{debit, credit, amount, txnType}`. */
function legs(deps: ReturnType<typeof buildDeps>, index = 0) {
  const call = deps.ledger.append.mock.calls[index][0];
  return {
    txnType: call.txnType,
    debit: call.debitAccount,
    credit: call.creditAccount,
    amount: call.amount,
    sourceRef: call.sourceRef,
  };
}

describe('money in', () => {
  it('books an online capture from the gateway into revenue', async () => {
    const deps = buildDeps();
    await build(deps).recordCapture({
      bookingId: 'bk-1',
      orderId: 'ord-1',
      razorpayPaymentId: 'pay_X',
      customerId: 'cust-1',
      amount: '1000.00',
    });

    expect(legs(deps)).toEqual({
      txnType: 'charge',
      debit: 'gateway:razorpay',
      credit: 'revenue:bookings',
      amount: '1000.00',
      sourceRef: 'capture:ord-1',
    });
  });

  /**
   * Cash never touches the gateway — the Pro is holding banknotes, so the
   * debit is to their own account and stays there until a handover clears it.
   */
  it('books a cash collection against the Pro’s own cash account', async () => {
    const deps = buildDeps();
    await build(deps).recordCashCollection({
      bookingId: 'bk-1',
      proId: 'pro-1',
      customerId: 'cust-1',
      amount: '1000.00',
    });

    expect(legs(deps)).toEqual({
      txnType: 'charge',
      debit: 'cash_in_hand:pro-1',
      credit: 'revenue:bookings',
      amount: '1000.00',
      sourceRef: 'cash:bk-1',
    });
  });

  it('clears the Pro’s cash account on handover, without booking revenue twice', async () => {
    const deps = buildDeps();
    await build(deps).recordHandover({
      handoverId: 'ho-1',
      proId: 'pro-1',
      amount: '4000.00',
    });

    expect(legs(deps)).toEqual({
      txnType: 'charge',
      debit: 'bank:platform',
      credit: 'cash_in_hand:pro-1',
      amount: '4000.00',
      sourceRef: 'handover:ho-1',
    });
  });

  it('books a refund against revenue, not as an expense', async () => {
    const deps = buildDeps();
    await build(deps).recordRefund({
      bookingId: 'bk-1',
      orderId: 'ord-1',
      razorpayPaymentId: 'pay_X',
      razorpayRefundId: 'rfnd_1',
      customerId: 'cust-1',
      amount: '250.00',
    });

    expect(legs(deps)).toEqual({
      txnType: 'refund',
      debit: 'revenue:bookings',
      credit: 'gateway:razorpay',
      amount: '250.00',
      sourceRef: 'refund:rfnd_1',
    });
  });
});

describe('money out', () => {
  it('books only the Pro’s share, never the platform’s', async () => {
    const deps = buildDeps();
    await build(deps).recordAccrual({
      commissionId: 'comm-1',
      bookingId: 'bk-1',
      proId: 'pro-1',
      commissionAmount: '300.00',
      platformAmount: '700.00',
    });

    expect(deps.ledger.append).toHaveBeenCalledTimes(1);
    expect(legs(deps)).toEqual({
      txnType: 'pro_commission',
      debit: 'expense:pro_commission',
      credit: 'payable:pro:pro-1',
      amount: '300.00',
      sourceRef: 'accrual:comm-1',
    });
  });

  it('books a bonus against its own expense account', async () => {
    const deps = buildDeps();
    await build(deps).recordIncentiveCredit({
      commissionId: 'comm-1',
      proId: 'pro-1',
      incentiveId: 'inc-1',
      amount: '2000.00',
    });

    expect(legs(deps)).toEqual({
      txnType: 'incentive',
      debit: 'expense:incentives',
      credit: 'payable:pro:pro-1',
      amount: '2000.00',
      sourceRef: 'incentive:inc-1:comm-1',
    });
  });

  it('books the transfer out of the bank', async () => {
    const deps = buildDeps();
    await build(deps).recordDisbursement({
      payoutId: 'payout-1',
      proId: 'pro-1',
      netAmount: '14500.00',
      payoutReference: 'UTR123',
    });

    expect(legs(deps)).toEqual({
      txnType: 'pro_commission',
      debit: 'payable:pro:pro-1',
      credit: 'bank:platform',
      amount: '14500.00',
      sourceRef: 'disbursement:payout-1',
    });
  });

  it('books a recovered deduction as revenue', async () => {
    const deps = buildDeps();
    await build(deps).recordDeductionRecovered({
      deductionId: 'ded-1',
      proId: 'pro-1',
      payoutId: 'payout-1',
      amount: '300.00',
      reason: 'Reversal',
    });

    expect(legs(deps)).toEqual({
      txnType: 'deduction',
      debit: 'payable:pro:pro-1',
      credit: 'revenue:recoveries',
      amount: '300.00',
      sourceRef: 'recovery:ded-1',
    });
  });
});

describe('reversal — the branch worth reading twice', () => {
  it('undoes the accrual when the money has not gone yet', async () => {
    const deps = buildDeps();
    await build(deps).recordReversal({
      commissionId: 'comm-1',
      proId: 'pro-1',
      amount: '300.00',
      incentiveAmount: '0.00',
      alreadyPaid: false,
      reason: 'Refunded',
    });

    expect(legs(deps)).toEqual({
      txnType: 'pro_commission',
      debit: 'payable:pro:pro-1',
      credit: 'expense:pro_commission',
      amount: '300.00',
      sourceRef: 'reversal:comm-1',
    });
  });

  it('gives an unwound bonus its own leg', async () => {
    const deps = buildDeps();
    await build(deps).recordReversal({
      commissionId: 'comm-1',
      proId: 'pro-1',
      amount: '300.00',
      incentiveAmount: '2000.00',
      alreadyPaid: false,
      reason: 'Refunded',
    });

    expect(deps.ledger.append).toHaveBeenCalledTimes(2);
    expect(legs(deps, 1)).toEqual({
      txnType: 'incentive',
      debit: 'payable:pro:pro-1',
      credit: 'expense:incentives',
      amount: '2000.00',
      sourceRef: 'reversal:incentive:comm-1',
    });
  });

  /**
   * The important one. The money is in the Pro's bank and `payable:pro` is
   * already zero — nothing has moved, and an append-only table must not claim
   * otherwise. What the platform holds is a *claim*, which lives in
   * `PayoutDeduction` and becomes an entry only when a later payout actually
   * recovers it.
   */
  it('books nothing at all when the money has already been paid', async () => {
    const deps = buildDeps();
    await build(deps).recordReversal({
      commissionId: 'comm-1',
      proId: 'pro-1',
      amount: '300.00',
      incentiveAmount: '2000.00',
      alreadyPaid: true,
      reason: 'Refunded',
    });

    expect(deps.ledger.append).not.toHaveBeenCalled();
  });
});

/**
 * The invariant the whole account model exists to produce: a Pro who has been
 * paid in full owes and is owed nothing. This walks the real sequence of
 * events and asserts `payable:pro` returns to zero — which is also what the
 * nightly reconciliation checks against the live table.
 */
describe('payable:pro nets to zero over a full cycle', () => {
  it('for earnings, a bonus, a deduction and a payout', async () => {
    const deps = buildDeps();
    const adapter = build(deps);
    const PRO = 'pro-1';

    await adapter.recordAccrual({
      commissionId: 'c1',
      bookingId: 'b1',
      proId: PRO,
      commissionAmount: '300.00',
      platformAmount: '700.00',
    });
    await adapter.recordAccrual({
      commissionId: 'c2',
      bookingId: 'b2',
      proId: PRO,
      commissionAmount: '450.00',
      platformAmount: '550.00',
    });
    await adapter.recordIncentiveCredit({
      commissionId: 'c2',
      proId: PRO,
      incentiveId: 'i1',
      amount: '250.00',
    });
    // Gross 1000.00, less a 200.00 recovery, net 800.00.
    await adapter.recordDeductionRecovered({
      deductionId: 'd1',
      proId: PRO,
      payoutId: 'p1',
      amount: '200.00',
      reason: 'Reversal',
    });
    await adapter.recordDisbursement({
      payoutId: 'p1',
      proId: PRO,
      netAmount: '800.00',
      payoutReference: 'UTR1',
    });

    const account = `payable:pro:${PRO}`;
    let balance = 0;
    for (const call of deps.ledger.append.mock.calls) {
      const entry = call[0];
      const paise = Math.round(Number(entry.amount) * 100);
      // Credit-normal: a payable grows on the credit side.
      if (entry.creditAccount === account) balance += paise;
      if (entry.debitAccount === account) balance -= paise;
    }

    expect(balance).toBe(0);
  });
});
