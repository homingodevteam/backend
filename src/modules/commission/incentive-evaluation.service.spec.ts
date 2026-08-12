import { IncentiveEvaluationService } from './incentive-evaluation.service';

const decimal = (value: string) => ({ toString: () => value });

/** 12 Aug 2026, 14:30 IST. */
const NOW = new Date('2026-08-12T09:00:00.000Z');

function buildDeps() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    proIncentiveProgress: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    bookingCommission: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };

  const prisma = {
    pro: {
      findUnique: jest.fn().mockResolvedValue({ id: 'pro-1', cityId: null }),
    },
    incentive: { findMany: jest.fn().mockResolvedValue([]) },
    proIncentiveProgress: {
      upsert: jest.fn().mockResolvedValue({
        id: 'prog-1',
        rewardCredited: false,
      }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    proIncentiveContribution: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    bookingCommission: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const ledger = {
    recordIncentiveCredit: jest.fn().mockResolvedValue(undefined),
  };

  return { prisma, tx, ledger };
}

function build(deps: ReturnType<typeof buildDeps>): IncentiveEvaluationService {
  return new IncentiveEvaluationService(
    deps.prisma as never,
    deps.ledger as never,
  );
}

function anIncentive(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inc-1',
    name: '50-job bonus',
    incentiveType: 'jobs_count',
    recurrence: 'monthly',
    criteriaJson: { target: 3 },
    rewardAmount: decimal('2000.00'),
    cityId: null,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: null,
    ...overrides,
  };
}

/**
 * `reviews` is a list, filtered to `reviewerType: 'customer'` by the query —
 * module 10 gave a booking a second review, the Pro's rating OF the customer,
 * in the same table. An empty list is an unrated job.
 */
function jobs(count: number, rated?: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `comm-${index + 1}`,
    booking: { reviews: rated === undefined ? [] : [{ rating: rated }] },
  }));
}

describe('evaluateForPro', () => {
  it('skips a type nobody has written rules for', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([
      anIncentive({ incentiveType: 'streak' }),
      anIncentive({ id: 'inc-2', incentiveType: 'surge_slot' }),
    ]);

    await build(deps).evaluateForPro('pro-1', 'comm-1', NOW);

    expect(deps.prisma.proIncentiveProgress.upsert).not.toHaveBeenCalled();
  });

  /** Point 4 of the review: recurrence is what makes a monthly bonus monthly. */
  it('keys progress by the Indian month for a monthly scheme', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([anIncentive()]);

    await build(deps).evaluateForPro('pro-1', 'comm-1', NOW);

    const { where, create } =
      deps.prisma.proIncentiveProgress.upsert.mock.calls[0][0];
    expect(where.proId_incentiveId_periodKey.periodKey).toBe('2026-08');
    expect(create.periodStart.toISOString()).toBe('2026-07-31T18:30:00.000Z');
  });

  it('keys a one-shot scheme to a single lifetime period', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([
      anIncentive({ recurrence: 'once' }),
    ]);

    await build(deps).evaluateForPro('pro-1', 'comm-1', NOW);

    expect(
      deps.prisma.proIncentiveProgress.upsert.mock.calls[0][0].where
        .proId_incentiveId_periodKey.periodKey,
    ).toBe('lifetime');
  });

  /**
   * Point 3 of the review. Progress is the sum of contribution rows, one per
   * job, so a reversal of any of them has something to follow back — not just
   * the job that happened to tip the total over.
   */
  it('writes one contribution row per qualifying job', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([anIncentive()]);
    deps.prisma.bookingCommission.findMany.mockResolvedValue(jobs(2));

    await build(deps).evaluateForPro('pro-1', 'comm-2', NOW);

    expect(
      deps.prisma.proIncentiveContribution.createMany,
    ).toHaveBeenCalledWith({
      data: [
        { progressId: 'prog-1', commissionId: 'comm-1', value: '1' },
        { progressId: 'prog-1', commissionId: 'comm-2', value: '1' },
      ],
      skipDuplicates: true,
    });
  });

  it('drops contributions from jobs that no longer qualify', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([anIncentive()]);
    deps.prisma.bookingCommission.findMany.mockResolvedValue(jobs(2));

    await build(deps).evaluateForPro('pro-1', 'comm-2', NOW);

    expect(
      deps.prisma.proIncentiveContribution.deleteMany,
    ).toHaveBeenCalledWith({
      where: {
        progressId: 'prog-1',
        commissionId: { notIn: ['comm-1', 'comm-2'] },
      },
    });
  });

  it('leaves the bar short when the target is not met', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([anIncentive()]);
    deps.prisma.bookingCommission.findMany.mockResolvedValue(jobs(2));

    await build(deps).evaluateForPro('pro-1', 'comm-2', NOW);

    expect(
      deps.prisma.proIncentiveProgress.update.mock.calls[0][0].data,
    ).toEqual({
      progressValue: '2.00',
      targetValue: '3.00',
      achievedAt: null,
    });
    expect(deps.tx.bookingCommission.update).not.toHaveBeenCalled();
  });

  it('credits the reward onto the job that triggered it', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([anIncentive()]);
    deps.prisma.bookingCommission.findMany.mockResolvedValue(jobs(3));
    deps.tx.proIncentiveProgress.findUnique.mockResolvedValue({
      id: 'prog-1',
      rewardCredited: false,
    });
    deps.tx.bookingCommission.findUnique.mockResolvedValue({
      id: 'comm-3',
      commissionAmount: decimal('300.00'),
      incentiveAmount: decimal('0.00'),
    });

    await build(deps).evaluateForPro('pro-1', 'comm-3', NOW);

    const progress = deps.tx.proIncentiveProgress.update.mock.calls[0][0].data;
    expect(progress.rewardCredited).toBe(true);
    // Snapshotted, so editing the scheme later cannot restate this.
    expect(progress.rewardAmount).toBe('2000.00');
    expect(progress.commissionId).toBe('comm-3');

    expect(deps.tx.bookingCommission.update.mock.calls[0][0].data).toEqual({
      incentiveAmount: '2000.00',
      netPayable: '2300.00',
    });
  });

  it('does not credit twice when two passes race', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([anIncentive()]);
    deps.prisma.bookingCommission.findMany.mockResolvedValue(jobs(3));
    // Another pass got there first, inside the lock.
    deps.tx.proIncentiveProgress.findUnique.mockResolvedValue({
      id: 'prog-1',
      rewardCredited: true,
    });

    await build(deps).evaluateForPro('pro-1', 'comm-3', NOW);

    expect(deps.tx.bookingCommission.update).not.toHaveBeenCalled();
  });

  it('leaves a scheme already won this period alone', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([anIncentive()]);
    deps.prisma.proIncentiveProgress.upsert.mockResolvedValue({
      id: 'prog-1',
      rewardCredited: true,
    });

    await build(deps).evaluateForPro('pro-1', 'comm-9', NOW);

    expect(
      deps.prisma.proIncentiveContribution.createMany,
    ).not.toHaveBeenCalled();
  });

  it('counts only rated jobs for a rating scheme, carrying the stars', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([
      anIncentive({
        incentiveType: 'rating',
        criteriaJson: { minJobs: 2, minRating: 4.5 },
      }),
    ]);
    deps.prisma.bookingCommission.findMany.mockResolvedValue([
      ...jobs(2, 5),
      { id: 'comm-3', booking: { reviews: [] } },
    ]);
    deps.tx.proIncentiveProgress.findUnique.mockResolvedValue({
      id: 'prog-1',
      rewardCredited: false,
    });
    deps.tx.bookingCommission.findUnique.mockResolvedValue({
      id: 'comm-2',
      commissionAmount: decimal('300.00'),
      incentiveAmount: decimal('0.00'),
    });

    await build(deps).evaluateForPro('pro-1', null, NOW);

    const { data } =
      deps.prisma.proIncentiveContribution.createMany.mock.calls[0][0];
    expect(data).toEqual([
      { progressId: 'prog-1', commissionId: 'comm-1', value: '5' },
      { progressId: 'prog-1', commissionId: 'comm-2', value: '5' },
    ]);
  });

  /**
   * Module 10 put a second review on every booking — the Pro's rating OF the
   * customer — in the same table. Without the direction filter a Pro could
   * reach a five-star bonus by rating their own customers five stars.
   *
   * Asserting the query rather than the outcome, because the mock cannot
   * reproduce what Postgres would return; the filter being present in the
   * `select` is the whole guarantee. Same root cause as
   * CONFLICTS_AND_DECISIONS #61.
   */
  it('reads only customer-authored reviews for a rating scheme', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([
      anIncentive({
        incentiveType: 'rating',
        criteriaJson: { minJobs: 2, minRating: 4.5 },
      }),
    ]);

    await build(deps).evaluateForPro('pro-1', null, NOW);

    const { select } = deps.prisma.bookingCommission.findMany.mock.calls[0][0];
    expect(select.booking.select.reviews.where).toEqual({
      reviewerType: 'customer',
    });
  });

  it('carries on when one scheme is misconfigured', async () => {
    const deps = buildDeps();
    deps.prisma.incentive.findMany.mockResolvedValue([
      anIncentive({ id: 'inc-bad', criteriaJson: { target: 'fifty' } }),
      anIncentive({ id: 'inc-good' }),
    ]);

    await expect(
      build(deps).evaluateForPro('pro-1', 'comm-1', NOW),
    ).resolves.toBeUndefined();
    expect(deps.prisma.proIncentiveProgress.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('unwindForCommission', () => {
  it('removes the job’s contributions and recounts what is left', async () => {
    const deps = buildDeps();
    deps.prisma.proIncentiveContribution.findMany
      .mockResolvedValueOnce([{ progressId: 'prog-1' }])
      .mockResolvedValueOnce([
        { value: decimal('1') },
        { value: decimal('1') },
      ]);

    await build(deps).unwindForCommission('comm-3');

    expect(
      deps.prisma.proIncentiveContribution.deleteMany,
    ).toHaveBeenCalledWith({
      where: { commissionId: 'comm-3' },
    });
    expect(deps.prisma.proIncentiveProgress.update).toHaveBeenCalledWith({
      where: { id: 'prog-1' },
      data: { progressValue: '2.00' },
    });
  });

  /** US-8.7's edge: otherwise a cancelled job banks a permanent bonus. */
  it('reports the snapshotted reward when the bonus was credited here', async () => {
    const deps = buildDeps();
    deps.prisma.proIncentiveContribution.findMany.mockResolvedValue([]);
    deps.prisma.proIncentiveProgress.findMany.mockResolvedValue([
      {
        id: 'prog-1',
        rewardAmount: decimal('1500.00'),
        incentive: { name: '50-job bonus', rewardAmount: decimal('2000.00') },
      },
    ]);

    const owed = await build(deps).unwindForCommission('comm-3');

    // The snapshot, not today's figure — recovering ₹2,000 for a bonus that
    // paid ₹1,500 would take money that was never given.
    expect(owed).toEqual([
      {
        progressId: 'prog-1',
        incentiveName: '50-job bonus',
        rewardAmount: '1500.00',
      },
    ]);
    expect(deps.prisma.proIncentiveProgress.update).toHaveBeenCalledWith({
      where: { id: 'prog-1' },
      data: {
        rewardCredited: false,
        rewardAmount: null,
        achievedAt: null,
        commissionId: null,
      },
    });
  });

  it('owes nothing when the job contributed but never triggered a reward', async () => {
    const deps = buildDeps();
    deps.prisma.proIncentiveContribution.findMany
      .mockResolvedValueOnce([{ progressId: 'prog-1' }])
      .mockResolvedValueOnce([]);

    await expect(build(deps).unwindForCommission('comm-3')).resolves.toEqual(
      [],
    );
  });
});
