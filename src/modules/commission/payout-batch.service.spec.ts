import { HttpException } from '@nestjs/common';
import { PayoutBatchService } from './payout-batch.service';

const decimal = (value: string) => ({ toString: () => value });

function buildDeps() {
  const created: Record<string, unknown>[] = [];

  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    bookingCommission: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    commissionPayout: {
      create: jest.fn().mockImplementation(({ data }: { data: object }) => {
        const row = { id: `payout-${created.length + 1}`, ...data };
        created.push(row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn(),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ id: 'payout-1', ...data }),
        ),
    },
    payoutDeduction: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
  };

  const prisma = {
    bookingCommission: { groupBy: jest.fn().mockResolvedValue([]) },
    pro: { findUnique: jest.fn() },
    commissionPayout: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const settings = {
    getNumber: jest
      .fn()
      .mockImplementation((_key: string, fallback: number) =>
        Promise.resolve(fallback),
      ),
    getString: jest
      .fn()
      .mockImplementation((_key: string, fallback: string) =>
        Promise.resolve(fallback),
      ),
  };

  const deductions = {
    planConsumption: jest.fn().mockResolvedValue({ total: '0.00', lines: [] }),
  };

  return { prisma, tx, settings, deductions, created };
}

function build(deps: ReturnType<typeof buildDeps>): PayoutBatchService {
  return new PayoutBatchService(
    deps.prisma as never,
    deps.settings as never,
    deps.deductions as never,
  );
}

function aPro(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pro-1',
    fullName: 'Anita Rao',
    phone: '+919000000001',
    status: 'approved',
    bankAccounts: [{ id: 'bank-1', upiId: 'anita@upi' }],
    ...overrides,
  };
}

const twoJobs = [
  {
    id: 'c1',
    commissionAmount: decimal('300.00'),
    incentiveAmount: decimal('0.00'),
  },
  {
    id: 'c2',
    commissionAmount: decimal('450.00'),
    incentiveAmount: decimal('50.00'),
  },
];

describe('generate', () => {
  it('sums the earning columns and attaches the jobs to the batch', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.pro.findUnique.mockResolvedValue(aPro());
    deps.tx.bookingCommission.findMany.mockResolvedValue(twoJobs);

    const result = await build(deps).generate({
      periodEnd: '2026-08-31T00:00:00.000Z',
    });

    expect(result.created).toBe(1);
    const { data } = deps.tx.commissionPayout.create.mock.calls[0][0];
    expect(data.commissionAmount).toBe('750.00');
    expect(data.incentiveAmount).toBe('50.00');
    expect(data.netAmount).toBe('800.00');
    expect(data.status).toBe('draft');
    expect(deps.tx.bookingCommission.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] } },
      data: { payoutId: 'payout-1' },
    });
  });

  /**
   * Point 5 of the review, and the reason the class comment is as long as it
   * is: keying inclusion on the completion date orphans a job that was held
   * behind a dispute and approved late.
   */
  it('includes every approved unpaid commission as of the period end, however old', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.pro.findUnique.mockResolvedValue(aPro());
    deps.tx.bookingCommission.findMany.mockResolvedValue(twoJobs);

    await build(deps).generate({ periodEnd: '2026-08-31T00:00:00.000Z' });

    const { where } = deps.tx.bookingCommission.findMany.mock.calls[0][0];
    expect(where.status).toBe('approved');
    expect(where.payoutId).toBeNull();
    expect(where.reversedAt).toBeNull();
    // An upper bound only. No lower bound, deliberately.
    expect(where.computedAt).toEqual({ lt: expect.any(Date) });
    expect(where.computedAt.gte).toBeUndefined();
  });

  it('creates nothing on a second run, because the jobs are no longer unpaid', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([]);

    const result = await build(deps).generate({});

    expect(result.created).toBe(0);
    expect(deps.tx.commissionPayout.create).not.toHaveBeenCalled();
  });

  it('skips and names a Pro with no verified bank account', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.pro.findUnique.mockResolvedValue(aPro({ bankAccounts: [] }));
    deps.tx.bookingCommission.findMany.mockResolvedValue(twoJobs);

    const result = await build(deps).generate({});

    expect(result.created).toBe(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        proId: 'pro-1',
        proName: 'Anita Rao',
        code: 'NO_VERIFIED_BANK_ACCOUNT',
        withheldAmount: '800.00',
      }),
    ]);
  });

  it('identifies a skipped Pro by phone when the KYC name is not there yet', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.pro.findUnique.mockResolvedValue(
      aPro({ fullName: null, bankAccounts: [] }),
    );
    deps.tx.bookingCommission.findMany.mockResolvedValue(twoJobs);

    const result = await build(deps).generate({});

    expect(result.skipped[0].proName).toBe('+919000000001');
  });

  /**
   * A verified account is not a payable one. This used to pass generation and
   * fail at the transfer, which is the worst possible moment to find out.
   */
  it('skips a Pro whose account is verified but has nowhere to send money', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.pro.findUnique.mockResolvedValue(
      aPro({ bankAccounts: [{ id: 'bank-1', upiId: null }] }),
    );
    deps.tx.bookingCommission.findMany.mockResolvedValue(twoJobs);

    const result = await build(deps).generate({});

    expect(result.created).toBe(0);
    expect(result.skipped[0].code).toBe('NO_PAYABLE_DESTINATION');
    expect(result.skipped[0].withheldAmount).toBe('800.00');
  });

  it('pays a Pro whose bank rail was registered out of band', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.pro.findUnique.mockResolvedValue(
      aPro({
        bankAccounts: [
          { id: 'bank-1', upiId: null, razorpayxFundAccountId: 'fa_1' },
        ],
      }),
    );
    deps.tx.bookingCommission.findMany.mockResolvedValue(twoJobs);

    await expect(build(deps).generate({})).resolves.toMatchObject({
      created: 1,
      skipped: [],
    });
  });

  it('rolls a sub-minimum net into the next period', async () => {
    const deps = buildDeps();
    deps.settings.getString.mockResolvedValue('1000.00');
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.pro.findUnique.mockResolvedValue(aPro());
    deps.tx.bookingCommission.findMany.mockResolvedValue(twoJobs);

    const result = await build(deps).generate({});

    expect(result.created).toBe(0);
    expect(result.skipped[0].code).toBe('BELOW_MINIMUM_NET');
  });

  it('rejects a period end that is not a date', async () => {
    const deps = buildDeps();
    await expect(
      build(deps).generate({ periodEnd: 'the end of August' }),
    ).rejects.toThrow(HttpException);
  });
});

describe('deductions inside a batch', () => {
  it('takes what is owed off the net', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.pro.findUnique.mockResolvedValue(aPro());
    deps.tx.bookingCommission.findMany.mockResolvedValue(twoJobs);
    deps.deductions.planConsumption.mockResolvedValue({
      total: '300.00',
      lines: [{ deductionId: 'ded-1', taken: '300.00', fullyConsumed: true }],
    });
    deps.tx.payoutDeduction.findUnique.mockResolvedValue({
      id: 'ded-1',
      proId: 'pro-1',
      amount: decimal('300.00'),
      kind: 'commission_reversal',
      reason: 'Reversal',
      sourceCommissionId: 'comm-9',
      raisedByAdminId: null,
    });

    await build(deps).generate({});

    const { data } = deps.tx.commissionPayout.create.mock.calls[0][0];
    expect(data.deductionAmount).toBe('300.00');
    expect(data.netAmount).toBe('500.00');
    // Taken whole — no remainder row.
    expect(deps.tx.payoutDeduction.create).not.toHaveBeenCalled();
  });

  /**
   * The split rule. `consumedByPayoutId` is one column, so a row half-claimed
   * by two batches could not be released exactly by either of them.
   */
  it('splits a deduction it cannot afford whole, leaving the rest for next time', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.groupBy.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.pro.findUnique.mockResolvedValue(aPro());
    deps.tx.bookingCommission.findMany.mockResolvedValue(twoJobs);
    deps.deductions.planConsumption.mockResolvedValue({
      total: '800.00',
      lines: [{ deductionId: 'ded-1', taken: '800.00', fullyConsumed: false }],
    });
    deps.tx.payoutDeduction.findUnique.mockResolvedValue({
      id: 'ded-1',
      proId: 'pro-1',
      amount: decimal('5000.00'),
      kind: 'commission_reversal',
      reason: 'Reversal of comm-9',
      sourceCommissionId: 'comm-9',
      raisedByAdminId: null,
    });

    await build(deps).generate({});

    // The payout lands at zero, never below it.
    expect(
      deps.tx.commissionPayout.create.mock.calls[0][0].data.netAmount,
    ).toBe('0.00');

    const remainder = deps.tx.payoutDeduction.create.mock.calls[0][0].data;
    expect(remainder.amount).toBe('4200.00');
    // The original keeps the dedupe key — a remainder is not a second reversal.
    expect(remainder.dedupeKey).toBeNull();

    const claimed = deps.tx.payoutDeduction.update.mock.calls[0][0].data;
    expect(claimed.amount).toBe('800.00');
    expect(claimed.consumedAmount).toBe('800.00');
    expect(claimed.consumedByPayoutId).toBe('payout-1');
  });
});

describe('approve', () => {
  it('moves a draft to approved and records who', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue({
      id: 'payout-1',
      status: 'approved',
    });

    await build(deps).approve('payout-1', 'admin-1');

    const [call] = deps.prisma.commissionPayout.updateMany.mock.calls;
    // Conditional, so two admins clicking at once resolve at the database.
    expect(call[0].where).toEqual({ id: 'payout-1', status: 'draft' });
    expect(call[0].data.approvedByAdminId).toBe('admin-1');
  });

  it('refuses anything that is not a draft', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.updateMany.mockResolvedValue({ count: 0 });
    deps.prisma.commissionPayout.findUnique.mockResolvedValue({
      id: 'payout-1',
      status: 'paid',
    });

    await expect(build(deps).approve('payout-1', 'admin-1')).rejects.toThrow(
      HttpException,
    );
  });
});

describe('reject', () => {
  it('releases the commissions and gives every deduction back in full', async () => {
    const deps = buildDeps();
    deps.tx.commissionPayout.findUnique.mockResolvedValue({
      id: 'payout-1',
      status: 'draft',
      deductions: [{ id: 'ded-1', consumedAmount: decimal('300.00') }],
    });

    await build(deps).reject('payout-1', 'Duplicated jobs', 'admin-1');

    expect(deps.tx.bookingCommission.updateMany).toHaveBeenCalledWith({
      where: { payoutId: 'payout-1' },
      data: { payoutId: null },
    });
    expect(deps.tx.payoutDeduction.update.mock.calls[0][0].data).toEqual({
      consumedAmount: '0',
      consumedByPayoutId: null,
      fullyConsumedAt: null,
    });
  });

  it('refuses to send back a batch whose money has already moved', async () => {
    const deps = buildDeps();
    deps.tx.commissionPayout.findUnique.mockResolvedValue({
      id: 'payout-1',
      status: 'paid',
      deductions: [],
    });

    await expect(
      build(deps).reject('payout-1', 'too late', 'admin-1'),
    ).rejects.toThrow(HttpException);
  });
});
