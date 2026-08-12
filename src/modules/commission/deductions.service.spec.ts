import { HttpException, HttpStatus } from '@nestjs/common';
import { DeductionsService } from './deductions.service';

const decimal = (value: string) => ({ toString: () => value });

function buildDeps() {
  const prisma = {
    payoutDeduction: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ id: 'ded-1', ...data }),
        ),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  return { prisma };
}

function build(deps: ReturnType<typeof buildDeps>): DeductionsService {
  return new DeductionsService(deps.prisma as never);
}

function aDeduction(amount: string, consumed = '0.00', id = 'ded-1') {
  return {
    id,
    proId: 'pro-1',
    amount: decimal(amount),
    consumedAmount: decimal(consumed),
  };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  return 200;
}

describe('raise', () => {
  it('creates a deduction', async () => {
    const deps = buildDeps();

    const row = await build(deps).raise({
      proId: 'pro-1',
      amount: '300.00',
      kind: 'commission_reversal',
      reason: 'Reversal',
      dedupeKey: 'commission_reversal:comm-1',
    });

    expect(row).toEqual(expect.objectContaining({ amount: '300.00' }));
  });

  /** "The same reversal cannot deduct twice", from the caller's side. */
  it('returns the existing row instead of raising a second one', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findUnique.mockResolvedValue(
      aDeduction('300.00'),
    );

    await build(deps).raise({
      proId: 'pro-1',
      amount: '300.00',
      kind: 'commission_reversal',
      reason: 'Reversal',
      dedupeKey: 'commission_reversal:comm-1',
    });

    expect(deps.prisma.payoutDeduction.create).not.toHaveBeenCalled();
  });

  /** And from the database's side, when two callers race past the read. */
  it('resolves a unique-violation race to the row that won', async () => {
    const deps = buildDeps();
    const winner = aDeduction('300.00');
    deps.prisma.payoutDeduction.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    deps.prisma.payoutDeduction.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );

    const row = await build(deps).raise({
      proId: 'pro-1',
      amount: '300.00',
      kind: 'commission_reversal',
      reason: 'Reversal',
      dedupeKey: 'commission_reversal:comm-1',
    });

    expect(row).toBe(winner);
  });

  it('raises nothing for a zero amount', async () => {
    const deps = buildDeps();

    const row = await build(deps).raise({
      proId: 'pro-1',
      amount: '0.00',
      kind: 'manual',
      reason: 'nothing',
    });

    expect(row).toBeNull();
    expect(deps.prisma.payoutDeduction.create).not.toHaveBeenCalled();
  });

  it('lets ops raise two manual deductions against the same job', async () => {
    const deps = buildDeps();
    const service = build(deps);

    await service.raise({
      proId: 'pro-1',
      amount: '150.00',
      kind: 'manual',
      reason: 'Uniform',
      sourceCommissionId: 'comm-1',
    });
    await service.raise({
      proId: 'pro-1',
      amount: '90.00',
      kind: 'manual',
      reason: 'Breakage',
      sourceCommissionId: 'comm-1',
    });

    expect(deps.prisma.payoutDeduction.create).toHaveBeenCalledTimes(2);
    // No dedupe key: NULLs are distinct in Postgres, which is what allows this.
    expect(
      deps.prisma.payoutDeduction.create.mock.calls[1][0].data.dedupeKey,
    ).toBeNull();
  });
});

describe('planConsumption', () => {
  it('takes nothing when nothing is owed', async () => {
    const deps = buildDeps();

    await expect(
      build(deps).planConsumption('pro-1', '1000.00'),
    ).resolves.toEqual({ total: '0.00', lines: [] });
  });

  it('takes debts whole, oldest first', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([
      aDeduction('300.00', '0.00', 'ded-1'),
      aDeduction('200.00', '0.00', 'ded-2'),
    ]);

    const plan = await build(deps).planConsumption('pro-1', '1000.00');

    expect(plan.total).toBe('500.00');
    expect(plan.lines).toEqual([
      { deductionId: 'ded-1', taken: '300.00', fullyConsumed: true },
      { deductionId: 'ded-2', taken: '200.00', fullyConsumed: true },
    ]);
  });

  /**
   * The rule that keeps a payout from going negative and keeps a large debt
   * from stalling forever.
   */
  it('takes part of a debt bigger than the earnings and stops', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([
      aDeduction('5000.00', '0.00', 'ded-1'),
      aDeduction('200.00', '0.00', 'ded-2'),
    ]);

    const plan = await build(deps).planConsumption('pro-1', '2000.00');

    expect(plan.total).toBe('2000.00');
    expect(plan.lines).toEqual([
      { deductionId: 'ded-1', taken: '2000.00', fullyConsumed: false },
    ]);
  });

  it('takes nothing from an empty period', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([
      aDeduction('300.00'),
    ]);

    const plan = await build(deps).planConsumption('pro-1', '0.00');

    expect(plan).toEqual({ total: '0.00', lines: [] });
  });
});

describe('outstandingTotal', () => {
  it('counts only what is left on each row', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([
      aDeduction('5000.00', '2000.00', 'ded-1'),
      aDeduction('200.00', '0.00', 'ded-2'),
    ]);

    await expect(build(deps).outstandingTotal('pro-1')).resolves.toBe(
      '3200.00',
    );
  });
});

describe('waive', () => {
  it('forgives an unrecovered deduction', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findUnique.mockResolvedValue({
      ...aDeduction('300.00'),
      waivedAt: null,
      fullyConsumedAt: null,
    });

    await build(deps).waive('ded-1', 'Raised in error', 'admin-1');

    expect(deps.prisma.payoutDeduction.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        waiveReason: 'Raised in error',
        waivedByAdminId: 'admin-1',
      }),
    );
  });

  /**
   * The consumed part has already reduced a payout that has already been sent.
   * "Un-taking" it here would leave the books saying the Pro was paid an amount
   * they were not.
   */
  it('will not un-take money already recovered from a payout', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findUnique.mockResolvedValue({
      ...aDeduction('300.00', '300.00'),
      waivedAt: null,
      fullyConsumedAt: new Date(),
    });

    expect(
      await statusOf(build(deps).waive('ded-1', 'too late', 'admin-1')),
    ).toBe(HttpStatus.CONFLICT);
  });

  it('will not waive twice', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findUnique.mockResolvedValue({
      ...aDeduction('300.00'),
      waivedAt: new Date(),
      fullyConsumedAt: null,
    });

    expect(await statusOf(build(deps).waive('ded-1', 'again', 'admin-1'))).toBe(
      HttpStatus.CONFLICT,
    );
  });

  it('is a 404 for a deduction that does not exist', async () => {
    const deps = buildDeps();
    deps.prisma.payoutDeduction.findUnique.mockResolvedValue(null);

    expect(await statusOf(build(deps).waive('nope', 'x', 'admin-1'))).toBe(
      HttpStatus.NOT_FOUND,
    );
  });
});
