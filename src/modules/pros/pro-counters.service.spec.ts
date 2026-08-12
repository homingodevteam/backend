import { ProCountersService } from './pro-counters.service';

function buildDeps() {
  const prisma = {
    assignmentCandidate: {
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    booking: { findUnique: jest.fn(), update: jest.fn() },
    bookingStatusEvent: { findFirst: jest.fn(), create: jest.fn() },
    review: { findUnique: jest.fn(), create: jest.fn() },
    pro: { update: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(prisma),
  );
  const redis = {
    setIfAbsent: jest.fn().mockResolvedValue(true),
    del: jest.fn(),
  };
  const config = { get: jest.fn().mockReturnValue('false') };
  return { prisma, redis, config };
}

describe('ProCountersService', () => {
  it('increments an offer exactly once for one assignment attempt', async () => {
    const deps = buildDeps();
    // The dispatch engine owns the candidate row now — it is the only thing
    // holding the score inputs — so idempotency is guarded by a marker event
    // rather than by the row's existence.
    deps.prisma.bookingStatusEvent.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'marker-1' });
    const service = new ProCountersService(
      deps.prisma as never,
      deps.redis as never,
      deps.config as never,
    );

    await service.recordOffer('booking-1', 1, 'pro-1', 4.2, 3);
    await service.recordOffer('booking-1', 1, 'pro-1', 4.2, 3);

    expect(deps.prisma.pro.update).toHaveBeenCalledTimes(1);
    expect(deps.prisma.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { assignmentsOffered: { increment: 1 } },
    });
  });

  it('does not clobber a candidate row the engine already wrote', async () => {
    const deps = buildDeps();
    deps.prisma.bookingStatusEvent.findFirst.mockResolvedValue(null);
    const service = new ProCountersService(
      deps.prisma as never,
      deps.redis as never,
      deps.config as never,
    );

    await service.recordOffer('booking-1', 1, 'pro-1', 4.2, 3);

    // Upsert with an empty update: the engine's scores survive.
    const [[call]] = deps.prisma.assignmentCandidate.upsert.mock.calls as [
      [{ update: Record<string, unknown> }],
    ];
    expect(call.update).toEqual({});
  });

  it('stores raw acknowledgement evidence and recomputes the fraction', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      proId: 'pro-1',
      assignmentOutcome: 'pending_ack',
      ackDeadlineAt: new Date(Date.now() + 60_000),
    });
    deps.prisma.bookingStatusEvent.findFirst.mockResolvedValue(null);
    deps.prisma.pro.update
      .mockResolvedValueOnce({
        assignmentsOffered: 4,
        assignmentsAcknowledged: 3,
      })
      .mockResolvedValueOnce({});
    const service = new ProCountersService(
      deps.prisma as never,
      deps.redis as never,
      deps.config as never,
    );

    await service.recordAcknowledgement('booking-1', 'pro-1');

    expect(deps.prisma.bookingStatusEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'assignment_acknowledged',
        actorId: 'pro-1',
      }),
    });
    expect(deps.prisma.pro.update).toHaveBeenLastCalledWith({
      where: { id: 'pro-1' },
      data: { acceptanceRate: 0.75 },
    });
  });

  /**
   * CONFLICTS_AND_DECISIONS #61 — the direction filter on the nightly rebuild.
   *
   * A `reviews` row carries both participants and `reviewerType` alone says
   * which of them wrote it. A Pro's review OF a customer therefore sits inside
   * the `GROUP BY "proId"` bucket, because the Pro is its author. Unfiltered,
   * the 02:00 job folds a Pro's opinion of a household into that Pro's own
   * public rating — and since this is the job that CORRECTS drift, the wrong
   * number would look authoritative.
   *
   * ## What these assertions are, and are not
   *
   * They read the SQL text. That does not prove Postgres computes the right
   * sums — nothing without a database can — but it does pin the exact line
   * that was wrong for the six months before module 10, and it fails loudly
   * for anyone who removes it. The behavioural check ran against the real
   * database when this shipped; see the plan's verification notes.
   */
  describe('rebuildAll · reviewer direction', () => {
    /**
     * A tagged template hands the mock `(strings, ...values)`, so the SQL is
     * the first argument. Joining on `?` restores the statement as one string
     * with the parameters marked, which is what the assertions match against.
     */
    function sqlFrom(mock: jest.Mock, index: number): string {
      const strings = mock.mock.calls[index]?.[0] as string[] | undefined;
      if (!strings) throw new Error(`No call at index ${index}`);
      return strings.join(' ? ');
    }

    async function runRebuild() {
      const deps = buildDeps();
      deps.prisma.$queryRaw.mockResolvedValue([
        {
          ratingDrift: 0n,
          assignmentDrift: 0n,
          completionDrift: 0n,
          customerRatingDrift: 0n,
        },
      ]);
      deps.prisma.$executeRaw.mockResolvedValue(1);

      const service = new ProCountersService(
        deps.prisma as never,
        deps.redis as never,
        deps.config as never,
      );
      await service.rebuildAll();
      return deps;
    }

    it('sums only customer-authored reviews into a Pro’s rating', async () => {
      const deps = await runRebuild();

      const proRebuild = sqlFrom(deps.prisma.$executeRaw, 0);
      expect(proRebuild).toContain('UPDATE "pros"');
      // The line itself. Without it a Pro rates themselves down every time
      // they flag a difficult household.
      expect(proRebuild).toMatch(
        /FROM "reviews" WHERE "reviewerType" = 'customer' GROUP BY "proId"/,
      );
      expect(proRebuild).not.toMatch(/FROM "reviews" GROUP BY "proId"/);
    });

    it('applies the same filter to the drift check that reports it', async () => {
      const deps = await runRebuild();

      // A drift query without the filter would report every Pro as drifted the
      // morning after the first Pro→customer review, and the alert would be
      // dismissed as noise.
      const drift = sqlFrom(deps.prisma.$queryRaw, 0);
      expect(drift).toMatch(
        /FROM "reviews" WHERE "reviewerType" = 'customer' GROUP BY "proId"/,
      );
    });

    it('rebuilds customer counters from the Pro direction, in their own statement', async () => {
      const deps = await runRebuild();

      const customerRebuild = sqlFrom(deps.prisma.$executeRaw, 1);
      expect(customerRebuild).toContain('UPDATE "customers"');
      expect(customerRebuild).toMatch(
        /FROM "reviews" WHERE "reviewerType" = 'pro' GROUP BY "customerId"/,
      );
      // Left-joined from `customers`, not from the review rows — a customer
      // whose only Pro review was deleted has to be reset to zero, and a join
      // starting at `reviews` would simply never visit them.
      expect(customerRebuild).toContain('FROM "customers" cu');
    });
  });
});
