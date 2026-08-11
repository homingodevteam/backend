import { HttpException } from '@nestjs/common';
import { CashHandoverService } from './cash-handover.service';

function buildDeps() {
  const tx = {
    pro: { findUnique: jest.fn(), update: jest.fn() },
    cashHandover: { update: jest.fn() },
  };
  const prisma = {
    pro: { findUnique: jest.fn() },
    cashHandover: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const ledger = { recordHandover: jest.fn() };
  return { prisma, tx, ledger };
}

function build(deps: ReturnType<typeof buildDeps>): CashHandoverService {
  return new CashHandoverService(deps.prisma as never, deps.ledger as never);
}

const decimal = (value: string) => ({ toString: () => value });

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    throw new Error('expected a rejection');
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe('CashHandoverService · declare', () => {
  it('records the declaration without moving the balance', async () => {
    const deps = buildDeps();
    deps.prisma.pro.findUnique.mockResolvedValue({
      cashInHand: decimal('5000.00'),
    });
    deps.prisma.cashHandover.create.mockResolvedValue({ id: 'ho-1' });

    await build(deps).declare('pro-1', '4500.00');

    expect(deps.prisma.cashHandover.create).toHaveBeenCalled();
    expect(deps.tx.pro.update).not.toHaveBeenCalled();
  });

  it('refuses to declare more than the Pro is recorded as carrying', async () => {
    const deps = buildDeps();
    deps.prisma.pro.findUnique.mockResolvedValue({
      cashInHand: decimal('1000.00'),
    });

    expect(await statusOf(build(deps).declare('pro-1', '4500.00'))).toBe(409);
  });

  /**
   * Two open declarations would let the same banknotes be confirmed twice and
   * drive the balance below what is really owed.
   */
  it('allows only one open declaration per Pro', async () => {
    const deps = buildDeps();
    deps.prisma.pro.findUnique.mockResolvedValue({
      cashInHand: decimal('5000.00'),
    });
    deps.prisma.cashHandover.findFirst.mockResolvedValue({ id: 'ho-open' });

    expect(await statusOf(build(deps).declare('pro-1', '100.00'))).toBe(409);
  });

  it('refuses a zero or negative declaration', async () => {
    const deps = buildDeps();
    deps.prisma.pro.findUnique.mockResolvedValue({
      cashInHand: decimal('5000.00'),
    });

    expect(await statusOf(build(deps).declare('pro-1', '0'))).toBe(400);
  });
});

describe('CashHandoverService · confirm', () => {
  function anOpenHandover(
    deps: ReturnType<typeof buildDeps>,
    declared = '4500.00',
  ) {
    deps.prisma.cashHandover.findUnique.mockResolvedValue({
      id: 'ho-1',
      proId: 'pro-1',
      status: 'declared',
      declaredAmount: decimal(declared),
    });
    deps.tx.pro.findUnique.mockResolvedValue({
      cashInHand: decimal('5000.00'),
    });
    deps.tx.cashHandover.update.mockResolvedValue({
      id: 'ho-1',
      proId: 'pro-1',
    });
  }

  it('is the only operation that reduces the balance', async () => {
    const deps = buildDeps();
    anOpenHandover(deps);

    await build(deps).confirm({
      handoverId: 'ho-1',
      adminId: 'admin-1',
      confirmedAmount: '4500.00',
    });

    expect(deps.tx.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { cashInHand: { decrement: '4500.00' } },
    });
  });

  /**
   * The variance is the entire point of counting. Moving the balance by the
   * declared figure instead would make the count ceremonial and write off the
   * shortfall silently.
   */
  it('moves the balance by what was counted, not by what was declared', async () => {
    const deps = buildDeps();
    anOpenHandover(deps, '4500.00');

    await build(deps).confirm({
      handoverId: 'ho-1',
      adminId: 'admin-1',
      confirmedAmount: '4000.00',
    });

    expect(deps.tx.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { cashInHand: { decrement: '4000.00' } },
    });
  });

  it('records who counted it — attribution is not optional here', async () => {
    const deps = buildDeps();
    anOpenHandover(deps);

    await build(deps).confirm({
      handoverId: 'ho-1',
      adminId: 'admin-1',
      confirmedAmount: '4500.00',
    });

    expect(deps.tx.cashHandover.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'confirmed',
          confirmedByAdminId: 'admin-1',
        }),
      }),
    );
  });

  /**
   * More handed over than we thought was held means a collection was never
   * recorded. Driving the balance negative would bury that.
   */
  it('refuses to confirm more than the recorded balance', async () => {
    const deps = buildDeps();
    anOpenHandover(deps);
    deps.tx.pro.findUnique.mockResolvedValue({
      cashInHand: decimal('1000.00'),
    });

    expect(
      await statusOf(
        build(deps).confirm({
          handoverId: 'ho-1',
          adminId: 'admin-1',
          confirmedAmount: '4500.00',
        }),
      ),
    ).toBe(409);
  });

  it('refuses to confirm a handover twice', async () => {
    const deps = buildDeps();
    deps.prisma.cashHandover.findUnique.mockResolvedValue({
      id: 'ho-1',
      status: 'confirmed',
    });

    expect(
      await statusOf(
        build(deps).confirm({
          handoverId: 'ho-1',
          adminId: 'admin-1',
          confirmedAmount: '4500.00',
        }),
      ),
    ).toBe(409);
  });
});

describe('CashHandoverService · reject', () => {
  it('leaves the balance untouched — nothing was recovered', async () => {
    const deps = buildDeps();
    deps.prisma.cashHandover.findUnique.mockResolvedValue({
      id: 'ho-1',
      proId: 'pro-1',
      status: 'declared',
      declaredAmount: decimal('4500.00'),
    });
    deps.prisma.cashHandover.update.mockResolvedValue({ id: 'ho-1' });

    await build(deps).reject({
      handoverId: 'ho-1',
      adminId: 'admin-1',
      reason: 'Pro did not attend',
    });

    expect(deps.tx.pro.update).not.toHaveBeenCalled();
    expect(deps.ledger.recordHandover).not.toHaveBeenCalled();
  });
});
