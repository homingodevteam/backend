import { DispatchScoringService } from './dispatch-scoring.service';
import type { DispatchSettings } from './dispatch.types';
import { HaversineRouter } from '../../routing/haversine.router';
import { RoutedTravelTimeService } from './ports/travel-time.port';

/**
 * The rules, tested directly.
 *
 * `dispatch.service.spec.ts` mocks this service wholesale, so until now every
 * assertion about "the too-far Pro is excluded" or "the busy Pro has no free
 * window" was really testing that the engine *persists* a result someone else
 * decided. The decisions themselves — the ones that get argued about — had no
 * coverage at all.
 */

const SETTINGS: DispatchSettings = {
  ackWindowSeconds: 120,
  candidatePoolSize: 10,
  maxAttempts: 3,
  rotationCooldownJobs: 2,
  travelSoftTargetMinutes: 30,
  assumedSpeedKmph: 20,
  ratingPriorMean: 4,
  ratingPriorWeight: 5,
  neighbourMarginKm: 1,
  allowWidenBeyondArea: true,
};

const CUSTOMER = { pinLat: 22.7533, pinLng: 75.8937 };

function buildDeps() {
  const prisma = {
    pro: {
      findMany: jest.fn().mockResolvedValue([]),
      /*
       * `computeFreeWindow` reads the Pro's booked break window. The default
       * is a Pro with no break booked, which is what every pre-existing case
       * in this file assumes.
       */
      findUnique: jest.fn().mockResolvedValue({
        scheduledBreakStartAt: null,
        scheduledBreakEndAt: null,
      }),
    },
    booking: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    assignmentCandidate: { count: jest.fn().mockResolvedValue(0) },
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    geoPosition: jest.fn().mockResolvedValue(null),
  };
  const settings = { getNumber: jest.fn(), getString: jest.fn() };
  /**
   * Real arithmetic, not a stub — the straight-line estimate is the thing
   * under test in half these cases.
   *
   * Wrapping the production classes rather than reimplementing haversine here:
   * a second copy in the test can agree with itself while disagreeing with the
   * code, which is the one failure a test like this must not have.
   */
  const routed = new RoutedTravelTimeService(new HaversineRouter());
  const travel = {
    estimateMinutes: jest.fn(routed.estimateMinutes.bind(routed)),
    estimateManyMinutes: jest.fn(routed.estimateManyMinutes.bind(routed)),
  };
  return { prisma, redis, settings, travel };
}

function build(deps: ReturnType<typeof buildDeps>): DispatchScoringService {
  return new DispatchScoringService(
    deps.prisma as never,
    deps.redis as never,
    deps.settings as never,
    deps.travel,
  );
}

function aPro(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pro-1',
    ratingSum: 40,
    ratingCount: 10,
    homeBaseLat: 22.75,
    homeBaseLng: 75.89,
    ...overrides,
  } as never;
}

function aBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bk-1',
    addressId: 'addr-1',
    slotStartAt: new Date('2026-08-12T10:00:00.000Z'),
    slotEndAt: new Date('2026-08-12T11:00:00.000Z'),
    address: CUSTOMER,
    ...overrides,
  } as never;
}

describe('DispatchScoringService · findEligiblePros', () => {
  it('requires approved, available, and holding the service', async () => {
    const deps = buildDeps();
    await build(deps).findEligiblePros('svc-1', 'city-1');

    expect(deps.prisma.pro.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'approved',
          isAvailable: true,
          cityId: 'city-1',
          services: { some: { serviceId: 'svc-1', isActive: true } },
        }),
      }),
    );
  });

  it('applies the cash ceiling as an exclusion', async () => {
    const deps = buildDeps();
    await build(deps).findEligiblePros('svc-1', 'city-1', ['pro-9']);

    const { where } = deps.prisma.pro.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(where.id).toEqual({ notIn: ['pro-9'] });
  });

  /**
   * The distinction dispatch depends on: `null` means "nobody posted, do not
   * filter"; `[]` would exclude everyone and report a supply gap for what is
   * really a configuration gap.
   */
  it('does not filter by area when the restriction is null', async () => {
    const deps = buildDeps();
    await build(deps).findEligiblePros('svc-1', 'city-1', [], null);

    const { where } = deps.prisma.pro.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(where.id).toBeUndefined();
  });

  it('restricts to the posted Pros when a list is given', async () => {
    const deps = buildDeps();
    await build(deps).findEligiblePros('svc-1', 'city-1', [], ['pro-1']);

    const { where } = deps.prisma.pro.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(where.id).toEqual({ in: ['pro-1'] });
  });

  /**
   * The Pro's own gate, alongside the admin's.
   *
   * `isAvailable` is ops saying this person is rostered today; `breakEndsAt`
   * is the Pro saying they have paused themselves for half an hour. Both have
   * to be clear, and a query that dropped this half would keep assigning work
   * to somebody the app is telling "no new jobs will be assigned to you".
   *
   * Expressed as a comparison rather than a flag because a break expires on
   * its own — nothing runs to clear it, so a Pro whose app died mid-break has
   * to return to this pool by the clock alone.
   */
  it('excludes a Pro whose break has not run out yet', async () => {
    const deps = buildDeps();
    await build(deps).findEligiblePros('svc-1', 'city-1');

    const { where } = deps.prisma.pro.findMany.mock.calls[0][0] as {
      where: { OR?: unknown[] };
    };

    expect(where.OR).toHaveLength(2);
    // Never on a break at all...
    expect(where.OR?.[0]).toEqual({ breakEndsAt: null });
    // ...or on one that has already elapsed.
    expect(where.OR?.[1]).toEqual({
      breakEndsAt: { lte: expect.any(Date) },
    });
  });
});

describe('DispatchScoringService · computeFreeWindow', () => {
  const slotStart = new Date('2026-08-12T10:00:00.000Z');
  const slotEnd = new Date('2026-08-12T11:00:00.000Z');

  it('gives the window when nothing is committed', async () => {
    const deps = buildDeps();
    await expect(
      build(deps).computeFreeWindow('pro-1', slotStart, slotEnd),
    ).resolves.toEqual({ start: slotStart, end: slotEnd });
  });

  /**
   * The half of the break feature that `findEligiblePros` cannot do.
   *
   * That query answers "can this Pro take a job right now". Dispatch also
   * assigns work with a `slotStartAt` hours away, so a Pro who books lunch at
   * 09:00 would otherwise be handed a 10:30 job at 09:05 — long before the
   * break starts, when nothing about their current state stops it. By the
   * time the break began the job would already be theirs.
   */
  it('refuses a slot that overlaps a booked break', async () => {
    const deps = buildDeps();
    deps.prisma.pro.findUnique.mockResolvedValue({
      scheduledBreakStartAt: new Date('2026-08-12T10:30:00.000Z'),
      scheduledBreakEndAt: new Date('2026-08-12T11:00:00.000Z'),
    });

    await expect(
      build(deps).computeFreeWindow('pro-1', slotStart, slotEnd),
    ).resolves.toBeNull();
  });

  /** Half-open, exactly as the committed-booking test below expects. */
  it('allows a slot that ends exactly when a booked break starts', async () => {
    const deps = buildDeps();
    deps.prisma.pro.findUnique.mockResolvedValue({
      scheduledBreakStartAt: slotEnd,
      scheduledBreakEndAt: new Date('2026-08-12T11:30:00.000Z'),
    });

    await expect(
      build(deps).computeFreeWindow('pro-1', slotStart, slotEnd),
    ).resolves.toEqual({ start: slotStart, end: slotEnd });
  });

  /** A half-written window cannot be compared, so it must not block anything. */
  it('ignores a break window with only one end set', async () => {
    const deps = buildDeps();
    deps.prisma.pro.findUnique.mockResolvedValue({
      scheduledBreakStartAt: new Date('2026-08-12T10:30:00.000Z'),
      scheduledBreakEndAt: null,
    });

    await expect(
      build(deps).computeFreeWindow('pro-1', slotStart, slotEnd),
    ).resolves.toEqual({ start: slotStart, end: slotEnd });
  });

  it('refuses when a committed job overlaps — a Pro is not in two places', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([
      {
        slotStartAt: new Date('2026-08-12T10:30:00.000Z'),
        slotEndAt: new Date('2026-08-12T11:30:00.000Z'),
      },
    ]);

    await expect(
      build(deps).computeFreeWindow('pro-1', slotStart, slotEnd),
    ).resolves.toBeNull();
  });

  /** Back-to-back is legal: one job ending exactly as the next begins. */
  it('allows a job that ends exactly when this one starts', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([
      {
        slotStartAt: new Date('2026-08-12T09:00:00.000Z'),
        slotEndAt: slotStart,
      },
    ]);

    await expect(
      build(deps).computeFreeWindow('pro-1', slotStart, slotEnd),
    ).resolves.not.toBeNull();
  });

  it('only counts committed work, never completed or cancelled', async () => {
    const deps = buildDeps();
    await build(deps).computeFreeWindow('pro-1', slotStart, slotEnd);

    const { where } = deps.prisma.booking.findMany.mock.calls[0][0] as {
      where: { status: { in: string[] } };
    };
    expect(where.status.in).toEqual([
      'assigned',
      'en_route',
      'arrived',
      'started',
    ]);
  });

  it('recomputes rather than dying on a poisoned cache entry', async () => {
    const deps = buildDeps();
    deps.redis.get.mockResolvedValue('{not json');

    await expect(
      build(deps).computeFreeWindow('pro-1', slotStart, slotEnd),
    ).resolves.not.toBeNull();
    expect(deps.prisma.booking.findMany).toHaveBeenCalled();
  });
});

describe('DispatchScoringService · resolveOrigin', () => {
  const slotStart = new Date('2026-08-12T10:00:00.000Z');

  /**
   * The preceding job wins over live GPS deliberately: for a scheduled
   * booking, where the Pro is *now* is irrelevant — what matters is where they
   * will be when they set off.
   */
  it('prefers the preceding job’s address over live GPS', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findFirst.mockResolvedValue({
      address: { pinLat: 22.7, pinLng: 75.85 },
    });
    deps.redis.geoPosition.mockResolvedValue({
      latitude: 22.6,
      longitude: 75.8,
    });

    await expect(build(deps).resolveOrigin(aPro(), slotStart)).resolves.toEqual(
      { originType: 'last_job_location', lat: 22.7, lng: 75.85 },
    );
  });

  /**
   * Pins the defect the old naming invited. The query must find the job
   * ending at or before the slot — the PRECEDING one. A "fix" to match the
   * former `nextJob` name would break origin resolution entirely.
   */
  it('looks backwards from the slot, not forwards', async () => {
    const deps = buildDeps();
    await build(deps).resolveOrigin(aPro(), slotStart);

    const { where, orderBy } = deps.prisma.booking.findFirst.mock
      .calls[0][0] as {
      where: { slotEndAt: { lte: Date } };
      orderBy: { slotEndAt: string };
    };
    expect(where.slotEndAt).toEqual({ lte: slotStart });
    expect(orderBy).toEqual({ slotEndAt: 'desc' });
  });

  it('falls back to live GPS when there is no preceding job', async () => {
    const deps = buildDeps();
    deps.redis.geoPosition.mockResolvedValue({
      latitude: 22.6,
      longitude: 75.8,
    });

    await expect(build(deps).resolveOrigin(aPro(), slotStart)).resolves.toEqual(
      { originType: 'current_location', lat: 22.6, lng: 75.8 },
    );
  });

  it('falls back to home base when the phone has gone quiet', async () => {
    const deps = buildDeps();
    await expect(build(deps).resolveOrigin(aPro(), slotStart)).resolves.toEqual(
      { originType: 'home_base', lat: 22.75, lng: 75.89 },
    );
  });

  it('returns null when there is nowhere to route from', async () => {
    const deps = buildDeps();
    await expect(
      build(deps).resolveOrigin(
        aPro({ homeBaseLat: null, homeBaseLng: null }),
        slotStart,
      ),
    ).resolves.toBeNull();
  });
});

describe('DispatchScoringService · scoreOne', () => {
  const now = new Date('2026-08-12T09:00:00.000Z');

  it('excludes a Pro already tried on this booking', async () => {
    const deps = buildDeps();
    const result = await build(deps).scoreOne(
      aPro(),
      aBooking(),
      60,
      new Set(['pro-1']),
      SETTINGS,
      now,
    );

    expect(result.excludedReason).toBe('already_tried');
    expect(result.rank).toBeNull();
  });

  it('excludes a Pro whose window is taken', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([
      {
        slotStartAt: new Date('2026-08-12T10:30:00.000Z'),
        slotEndAt: new Date('2026-08-12T11:30:00.000Z'),
      },
    ]);

    const result = await build(deps).scoreOne(
      aPro(),
      aBooking(),
      60,
      new Set(),
      SETTINGS,
      now,
    );

    expect(result.excludedReason).toBe('unavailable');
  });

  it('excludes a Pro with no resolvable origin', async () => {
    const deps = buildDeps();
    const result = await build(deps).scoreOne(
      aPro({ homeBaseLat: null, homeBaseLng: null }),
      aBooking(),
      60,
      new Set(),
      SETTINGS,
      now,
    );

    expect(result.excludedReason).toBe('unavailable');
    expect(result.window).not.toBeNull();
  });

  /**
   * The change from #47, asserted directly. A Pro two hours away used to be
   * dropped as `out_of_range`; now they are scored and rankable, because a
   * long trip beats no service and the number that refused them was a guess
   * applied to a guess.
   */
  it('does NOT exclude a Pro for being far away', async () => {
    const deps = buildDeps();
    // Bhopal — roughly 190 km from the customer.
    const result = await build(deps).scoreOne(
      aPro({ homeBaseLat: 23.2599, homeBaseLng: 77.4126 }),
      aBooking(),
      60,
      new Set(),
      SETTINGS,
      now,
    );

    expect(result.excludedReason).toBeNull();
    expect(result.travelTimeMinutes).toBeGreaterThan(
      SETTINGS.travelSoftTargetMinutes,
    );
    expect(result.finalRankScore).toBeGreaterThan(0);
  });

  it('scores a near Pro above a far one', async () => {
    const deps = buildDeps();
    const service = build(deps);

    const near = await service.scoreOne(
      aPro({ id: 'near', homeBaseLat: 22.755, homeBaseLng: 75.895 }),
      aBooking(),
      60,
      new Set(),
      SETTINGS,
      now,
    );
    const far = await service.scoreOne(
      aPro({ id: 'far', homeBaseLat: 22.9, homeBaseLng: 76.1 }),
      aBooking(),
      60,
      new Set(),
      SETTINGS,
      now,
    );

    expect(near.finalRankScore!).toBeGreaterThan(far.finalRankScore!);
  });

  it('uses the configured speed to turn distance into minutes', async () => {
    const deps = buildDeps();
    await build(deps).scoreOne(
      aPro(),
      aBooking(),
      60,
      new Set(),
      SETTINGS,
      now,
    );

    expect(deps.travel.estimateMinutes).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      CUSTOMER.pinLat,
      CUSTOMER.pinLng,
      SETTINGS.assumedSpeedKmph,
    );
  });

  it('records every score input, so an assignment stays explainable', async () => {
    const deps = buildDeps();
    const result = await build(deps).scoreOne(
      aPro(),
      aBooking(),
      60,
      new Set(),
      SETTINGS,
      now,
    );

    expect(result).toMatchObject({
      window: expect.any(Object),
      origin: expect.any(Object),
      distanceKm: expect.any(Number),
      travelTimeMinutes: expect.any(Number),
      rotationScore: expect.any(Number),
      durationFitScore: expect.any(Number),
      ratingScore: expect.any(Number),
      offersToday: expect.any(Number),
      finalRankScore: expect.any(Number),
    });
  });

  /** Rotation is a penalty, not an exclusion — a cooled Pro still beats nobody. */
  it('penalises but never excludes a Pro who served this household', async () => {
    const deps = buildDeps();
    deps.prisma.booking.count.mockResolvedValue(5);

    const result = await build(deps).scoreOne(
      aPro(),
      aBooking(),
      60,
      new Set(),
      SETTINGS,
      now,
    );

    expect(result.excludedReason).toBeNull();
    expect(result.rotationScore).toBe(0);
  });
});

describe('DispatchScoringService · rank', () => {
  const scored = (overrides: Record<string, unknown>) =>
    ({
      proId: 'p',
      excludedReason: null,
      finalRankScore: 0.5,
      durationFitScore: 0.5,
      ratingScore: 4,
      offersToday: 0,
      rank: null,
      ...overrides,
    }) as never;

  it('drops excluded candidates and numbers the rest from one', () => {
    const deps = buildDeps();
    const ranked = build(deps).rank([
      scored({ proId: 'a', finalRankScore: 0.9 }),
      scored({ proId: 'b', excludedReason: 'unavailable' }),
      scored({ proId: 'c', finalRankScore: 0.7 }),
    ]);

    expect(ranked.map((c) => c.proId)).toEqual(['a', 'c']);
    expect(ranked.map((c) => c.rank)).toEqual([1, 2]);
  });

  it('breaks a dead tie by Pro id, so a rerun explains itself the same way', () => {
    const deps = buildDeps();
    const ranked = build(deps).rank([
      scored({ proId: 'zzz' }),
      scored({ proId: 'aaa' }),
    ]);

    expect(ranked[0].proId).toBe('aaa');
  });

  it('spreads load before falling back to the id', () => {
    const deps = buildDeps();
    const ranked = build(deps).rank([
      scored({ proId: 'aaa', offersToday: 5 }),
      scored({ proId: 'zzz', offersToday: 0 }),
    ]);

    expect(ranked[0].proId).toBe('zzz');
  });
});
