import { CommissionService } from './commission.service';

const decimal = (value: string) => ({ toString: () => value });

function buildDeps() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    bookingCommission: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ id: 'comm-1', ...data }),
        ),
    },
  };

  const prisma = {
    bookingCommission: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    booking: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
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
  };
  const incentives = { evaluateForPro: jest.fn().mockResolvedValue(undefined) };
  const ledger = { recordAccrual: jest.fn().mockResolvedValue(undefined) };

  return { prisma, tx, settings, incentives, ledger };
}

function build(deps: ReturnType<typeof buildDeps>): CommissionService {
  return new CommissionService(
    deps.prisma as never,
    deps.settings as never,
    deps.incentives as never,
    deps.ledger as never,
  );
}

function aCompletedBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bk-1',
    status: 'completed',
    proId: 'pro-1',
    serviceId: 'svc-1',
    flatPrice: decimal('1000.00'),
    startedAt: new Date('2026-08-12T04:00:00.000Z'),
    completedAt: new Date('2026-08-12T06:00:00.000Z'),
    actualDurationMinutes: 120,
    service: { commissionType: 'percent', commissionValue: decimal('30.00') },
    ...overrides,
  };
}

describe('CommissionService.recordCompletion', () => {
  it('writes the Pro’s share and the platform’s, summing to the price', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(aCompletedBooking());

    await build(deps).recordCompletion('bk-1', 'pro-1');

    const { data } = deps.tx.bookingCommission.create.mock.calls[0][0];
    expect(data.commissionAmount).toBe('300.00');
    expect(data.platformAmount).toBe('700.00');
    expect(data.netPayable).toBe('300.00');
    expect(data.status).toBe('pending');
  });

  /**
   * US-8.3 — the single most important property in the module. The row must
   * carry the rate it was paid at, not a pointer to a rate somebody can edit.
   */
  it('snapshots the rate onto the row', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(aCompletedBooking());

    await build(deps).recordCompletion('bk-1', 'pro-1');

    const { data } = deps.tx.bookingCommission.create.mock.calls[0][0];
    expect(data.commissionType).toBe('percent');
    expect(data.commissionValue.toString()).toBe('30.00');
  });

  /** CONFLICTS_AND_DECISIONS #18. Recorded, never read. */
  it('records the duration but pays the same whatever it was', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aCompletedBooking({ actualDurationMinutes: 15 }),
    );
    await build(deps).recordCompletion('bk-1', 'pro-1');
    const short = deps.tx.bookingCommission.create.mock.calls[0][0].data;

    const longer = buildDeps();
    longer.prisma.booking.findUnique.mockResolvedValue(
      aCompletedBooking({ actualDurationMinutes: 480 }),
    );
    await build(longer).recordCompletion('bk-1', 'pro-1');
    const long = longer.tx.bookingCommission.create.mock.calls[0][0].data;

    expect(short.actualDurationMinutes).toBe(15);
    expect(long.actualDurationMinutes).toBe(480);
    expect(short.commissionAmount).toBe(long.commissionAmount);
  });

  it('is a no-op when a row already exists', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue({
      id: 'comm-1',
    });

    await build(deps).recordCompletion('bk-1', 'pro-1');

    expect(deps.prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(deps.tx.bookingCommission.create).not.toHaveBeenCalled();
  });

  it('is a no-op when another writer won the race inside the lock', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(aCompletedBooking());
    deps.tx.bookingCommission.findUnique.mockResolvedValue({ id: 'comm-1' });

    await build(deps).recordCompletion('bk-1', 'pro-1');

    expect(deps.tx.bookingCommission.create).not.toHaveBeenCalled();
    expect(deps.ledger.recordAccrual).not.toHaveBeenCalled();
  });

  /** US-8.5's edge: no verified start, no proof the Pro was ever there. */
  it('pays nothing for a job with no verified start', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aCompletedBooking({ startedAt: null }),
    );

    await build(deps).recordCompletion('bk-1', 'pro-1');

    expect(deps.tx.bookingCommission.create).not.toHaveBeenCalled();
  });

  /** US-8.8 — the service went live with no rate. */
  it('pays nothing, loudly, when the service has no rate', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aCompletedBooking({
        service: { commissionType: null, commissionValue: null },
      }),
    );

    await build(deps).recordCompletion('bk-1', 'pro-1');

    expect(deps.tx.bookingCommission.create).not.toHaveBeenCalled();
  });

  it('refuses to pay a Pro the job is not assigned to', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aCompletedBooking({ proId: 'pro-2' }),
    );

    await build(deps).recordCompletion('bk-1', 'pro-1');

    expect(deps.tx.bookingCommission.create).not.toHaveBeenCalled();
  });

  it('does not pay for a job that is not completed', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aCompletedBooking({ status: 'started' }),
    );

    await build(deps).recordCompletion('bk-1', 'pro-1');

    expect(deps.tx.bookingCommission.create).not.toHaveBeenCalled();
  });

  it('caps a flat rate that exceeds the job price instead of going negative', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aCompletedBooking({
        flatPrice: decimal('200.00'),
        service: { commissionType: 'flat', commissionValue: decimal('220.00') },
      }),
    );

    await build(deps).recordCompletion('bk-1', 'pro-1');

    const { data } = deps.tx.bookingCommission.create.mock.calls[0][0];
    expect(data.commissionAmount).toBe('200.00');
    expect(data.platformAmount).toBe('0.00');
  });

  /**
   * The commission is already committed by this point. A bonus that fails to
   * evaluate is retried by the periodic pass; taking the pay down with it
   * would not be.
   */
  it('keeps the commission when incentive evaluation throws', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(aCompletedBooking());
    deps.incentives.evaluateForPro.mockRejectedValue(new Error('boom'));

    await expect(
      build(deps).recordCompletion('bk-1', 'pro-1'),
    ).resolves.toBeUndefined();
    expect(deps.tx.bookingCommission.create).toHaveBeenCalled();
  });
});

describe('CommissionService.sweepMissing', () => {
  it('reports nothing when every completed job has been paid', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([]);

    await expect(build(deps).sweepMissing()).resolves.toEqual({
      found: 0,
      written: 0,
    });
  });

  it('writes the commission for a job the completion hook missed', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([
      { id: 'bk-1', proId: 'pro-1' },
    ]);
    deps.prisma.booking.findUnique.mockResolvedValue(aCompletedBooking());

    await expect(build(deps).sweepMissing()).resolves.toEqual({
      found: 1,
      written: 1,
    });
    expect(deps.tx.bookingCommission.create).toHaveBeenCalled();
  });

  it('keeps going when one job cannot be written', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([
      { id: 'bk-1', proId: 'pro-1' },
      { id: 'bk-2', proId: 'pro-2' },
    ]);
    deps.prisma.booking.findUnique
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(aCompletedBooking({ id: 'bk-2', proId: 'pro-2' }));

    await expect(build(deps).sweepMissing()).resolves.toEqual({
      found: 2,
      written: 1,
    });
  });
});

describe('CommissionService.approveMatured', () => {
  it('only approves rows past the hold window, and only clean ones', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.updateMany.mockResolvedValue({ count: 3 });

    await expect(build(deps).approveMatured()).resolves.toBe(3);

    const [call] = deps.prisma.bookingCommission.updateMany.mock.calls;
    expect(call[0].where.status).toBe('pending');
    expect(call[0].where.computedAt.lte).toBeInstanceOf(Date);
    // US-8.9's edge: a job with a refund or a cancellation in flight is still
    // being decided and must not be swept into a batch.
    expect(call[0].where.booking).toEqual({
      refundedAmount: null,
      cancelledAt: null,
    });
    expect(call[0].data.status).toBe('approved');
  });
});
