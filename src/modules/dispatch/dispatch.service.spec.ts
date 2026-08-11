import { HttpException, HttpStatus } from '@nestjs/common';
import { DispatchService } from './dispatch.service';

function buildDeps() {
  const prisma = {
    booking: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    assignmentCandidate: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const redis = {
    setIfAbsent: jest.fn().mockResolvedValue(true),
    del: jest.fn(),
    listPush: jest.fn(),
    listPop: jest.fn(),
    listLength: jest.fn().mockResolvedValue(0),
  };
  const scoring = {
    loadSettings: jest.fn().mockResolvedValue({
      ackWindowSeconds: 120,
      candidatePoolSize: 10,
      maxAttempts: 3,
      rotationCooldownJobs: 2,
      maxTravelMinutes: 60,
      assumedSpeedKmph: 20,
      ratingPriorMean: 4,
      ratingPriorWeight: 5,
    }),
    findEligiblePros: jest.fn().mockResolvedValue([]),
    scoreOne: jest.fn(),
    rank: jest.fn((c: unknown[]) => c),
  };
  const state = { transition: jest.fn(), recordEvent: jest.fn() };
  const counters = { recordOffer: jest.fn(), recordAcknowledgement: jest.fn() };
  // Module 7's cash ceiling. Nobody is over it by default, so every existing
  // expectation about who is eligible is unchanged.
  const cash = { blockedProIds: jest.fn().mockResolvedValue([]) };
  // Module 13's area posting. `null` means "nobody posted, so do not filter",
  // which leaves every existing expectation about eligibility unchanged.
  const areas = { proIdsForArea: jest.fn().mockResolvedValue(null) };
  return { prisma, redis, scoring, state, counters, cash, areas };
}

function build(deps: ReturnType<typeof buildDeps>): DispatchService {
  return new DispatchService(
    deps.prisma as never,
    deps.redis as never,
    deps.scoring as never,
    deps.state as never,
    deps.counters as never,
    deps.cash as never,
    deps.areas as never,
  );
}

async function captureStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

const assigningBooking = {
  id: 'bk-1',
  status: 'assigning',
  serviceId: 'svc-1',
  addressId: 'addr-1',
  assignmentAttempt: 0,
  address: { pinLat: 22.7, pinLng: 75.85, cityId: 'city-1' },
  service: { durationMinutes: 60 },
};

describe('DispatchService', () => {
  describe('the distributed lock', () => {
    it('refuses a second concurrent run on the same booking', async () => {
      const deps = buildDeps();
      deps.redis.setIfAbsent.mockResolvedValue(false);
      const dispatch = build(deps);

      await expect(captureStatus(dispatch.run('bk-1'))).resolves.toBe(
        HttpStatus.CONFLICT,
      );
      // A booking can never be double-assigned, however many drains land.
      expect(deps.prisma.booking.findUnique).not.toHaveBeenCalled();
    });

    it('always releases the lock, even when the attempt throws', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(null);
      const dispatch = build(deps);

      await captureStatus(dispatch.run('bk-1'));

      expect(deps.redis.del).toHaveBeenCalledWith('dispatch:lock:bk-1');
    });
  });

  describe('no_supply vs exhausted — US-5.5 vs US-5.10', () => {
    it('reports an empty Rule 1 pool as a supply gap, not a failure', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(assigningBooking);
      deps.scoring.findEligiblePros.mockResolvedValue([]);
      const dispatch = build(deps);

      const result = await dispatch.run('bk-1');

      expect(result.outcome).toBe('no_supply');
      expect(deps.state.recordEvent).toHaveBeenCalledWith(
        'bk-1',
        'no_supply',
        'system',
        'dispatch',
      );
    });

    it('reports exhaustion separately when candidates existed but none won', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(assigningBooking);
      deps.scoring.findEligiblePros.mockResolvedValue([{ id: 'pro-1' }]);
      deps.scoring.scoreOne.mockResolvedValue({
        proId: 'pro-1',
        excludedReason: 'already_tried',
        rank: null,
      });
      deps.scoring.rank.mockReturnValue([]);
      const dispatch = build(deps);

      const result = await dispatch.run('bk-1');

      expect(result.outcome).toBe('exhausted');
    });

    /**
     * Module 13's area posting is a FILTER on the pool. Distance, rotation and
     * smoothed rating still do the ranking — this only narrows who is in it.
     */
    it('restricts the pool to Pros posted to the booking’s area', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        ...assigningBooking,
        areaId: 'area-vn',
      });
      deps.areas.proIdsForArea.mockResolvedValue(['pro-1', 'pro-2']);
      const dispatch = build(deps);

      await dispatch.run('bk-1');

      expect(deps.scoring.findEligiblePros).toHaveBeenCalledWith(
        'svc-1',
        'city-1',
        [],
        ['pro-1', 'pro-2'],
      );
    });

    /**
     * The distinction that keeps a configuration gap from masquerading as a
     * supply gap: nobody posted means no filter, not "exclude everyone".
     */
    it('does not filter when nobody is posted to the area', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        ...assigningBooking,
        areaId: 'area-vn',
      });
      deps.areas.proIdsForArea.mockResolvedValue(null);
      const dispatch = build(deps);

      await dispatch.run('bk-1');

      expect(deps.scoring.findEligiblePros).toHaveBeenCalledWith(
        'svc-1',
        'city-1',
        [],
        null,
      );
    });

    it('does not ask about areas for a booking that has none', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(assigningBooking);
      const dispatch = build(deps);

      await dispatch.run('bk-1');

      expect(deps.areas.proIdsForArea).not.toHaveBeenCalled();
    });

    it('stops after the configured attempt ceiling', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        ...assigningBooking,
        assignmentAttempt: 3,
      });
      const dispatch = build(deps);

      const result = await dispatch.run('bk-1');

      expect(result.outcome).toBe('exhausted');
      // Never even looks for Pros once the ceiling is hit.
      expect(deps.scoring.findEligiblePros).not.toHaveBeenCalled();
    });
  });

  describe('assignment', () => {
    const winner = {
      proId: 'pro-1',
      excludedReason: null,
      rank: 1,
      window: null,
      origin: null,
      distanceKm: 2,
      travelTimeMinutes: 6,
      rotationScore: 1,
      durationFitScore: 1,
      ratingScore: 4,
      offersToday: 0,
      finalRankScore: 0.9,
    };

    function ready() {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(assigningBooking);
      deps.scoring.findEligiblePros.mockResolvedValue([{ id: 'pro-1' }]);
      deps.scoring.scoreOne.mockResolvedValue(winner);
      deps.scoring.rank.mockReturnValue([winner]);
      return deps;
    }

    it('writes the winner onto the booking and opens the ack window', async () => {
      const deps = ready();
      const dispatch = build(deps);

      const result = await dispatch.run('bk-1');

      expect(result.outcome).toBe('assigned');
      expect(result.assignedProId).toBe('pro-1');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ to: string; data: Record<string, unknown> }],
      ];
      expect(call.to).toBe('assigned');
      expect(call.data.assignmentOutcome).toBe('pending_ack');
      expect(call.data.ackDeadlineAt).toBeInstanceOf(Date);
    });

    it('persists a row for excluded Pros too, so exclusions stay explainable', async () => {
      const deps = ready();
      deps.scoring.findEligiblePros.mockResolvedValue([
        { id: 'pro-1' },
        { id: 'pro-2' },
      ]);
      deps.scoring.scoreOne
        .mockResolvedValueOnce(winner)
        .mockResolvedValueOnce({
          proId: 'pro-2',
          excludedReason: 'out_of_range',
          rank: null,
        });
      const dispatch = build(deps);

      await dispatch.run('bk-1');

      const [[call]] = deps.prisma.assignmentCandidate.createMany.mock
        .calls as [
        [{ data: Array<{ proId: string; excludedReason: string | null }> }],
      ];
      expect(call.data.map((r) => r.proId).sort()).toEqual(['pro-1', 'pro-2']);
      expect(call.data.find((r) => r.proId === 'pro-2')?.excludedReason).toBe(
        'out_of_range',
      );
    });

    it('does not fail the assignment when the offer counter throws', async () => {
      const deps = ready();
      deps.counters.recordOffer.mockRejectedValue(new Error('counter down'));
      const dispatch = build(deps);

      // Derived data is rebuilt nightly — a statistic must not cost a customer
      // their assignment.
      await expect(dispatch.run('bk-1')).resolves.toMatchObject({
        outcome: 'assigned',
      });
    });

    it('refuses to dispatch a booking that is not assigning', async () => {
      const deps = ready();
      deps.prisma.booking.findUnique.mockResolvedValue({
        ...assigningBooking,
        status: 'completed',
      });
      const dispatch = build(deps);

      await expect(captureStatus(dispatch.run('bk-1'))).resolves.toBe(
        HttpStatus.CONFLICT,
      );
    });
  });

  describe('acknowledgement — US-5.2', () => {
    it('delegates entirely to the counters service', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        id: 'bk-1',
        proId: 'pro-1',
        assignmentOutcome: 'pending_ack',
      });
      const dispatch = build(deps);

      await dispatch.acknowledge('pro-1', 'bk-1');

      // It must write nothing itself. Updating the booking here first would
      // move assignmentOutcome off `pending_ack` and make the counter refuse
      // its own work — a bug this codebase has already had twice.
      expect(deps.prisma.booking.update).not.toHaveBeenCalled();
      expect(deps.counters.recordAcknowledgement).toHaveBeenCalledWith(
        'bk-1',
        'pro-1',
      );
    });

    it('hides another Pro’s booking behind a 404', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        id: 'bk-1',
        proId: 'someone-else',
      });
      const dispatch = build(deps);

      await expect(
        captureStatus(dispatch.acknowledge('pro-1', 'bk-1')),
      ).resolves.toBe(HttpStatus.NOT_FOUND);
      expect(deps.counters.recordAcknowledgement).not.toHaveBeenCalled();
    });
  });

  describe('queue', () => {
    it('enqueues rather than dispatching inline', async () => {
      const deps = buildDeps();
      const dispatch = build(deps);

      await dispatch.enqueue('bk-1');

      expect(deps.redis.listPush).toHaveBeenCalledWith(
        'dispatch:queue',
        'bk-1',
      );
    });

    it('keeps draining after one booking fails', async () => {
      const deps = buildDeps();
      deps.redis.listPop
        .mockResolvedValueOnce('bad')
        .mockResolvedValueOnce('bk-1')
        .mockResolvedValue(null);
      deps.prisma.booking.findUnique
        .mockResolvedValueOnce(null) // 'bad' -> throws
        .mockResolvedValue(assigningBooking);
      const dispatch = build(deps);

      const results = await dispatch.drain();

      expect(results).toHaveLength(1);
      expect(results[0].bookingId).toBe('bk-1');
    });
  });
});
