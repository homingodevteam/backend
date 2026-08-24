import { Injectable } from '@nestjs/common';
import type { Booking, Pro } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import type {
  DispatchSettings,
  FreeWindow,
  ScoredCandidate,
  TravelOrigin,
} from './dispatch.types';
import {
  durationFit,
  finalRankScore,
  haversineKm,
  rotationScore,
  smoothedRating,
} from './dispatch.types';
import {
  TRAVEL_TIME_PORT,
  type TravelTimePort,
} from './ports/travel-time.port';
import { Inject } from '@nestjs/common';

const PRO_LIVE_GEO_KEY = 'pros:live';
const FREE_WINDOW_TTL_SECONDS = 300;

/** Statuses that occupy a Pro's calendar — committed work, not history. */
const COMMITTED_STATUSES = [
  'assigned',
  'en_route',
  'arrived',
  'started',
] as const;

/**
 * Everything that turns a Pro into a ranked candidate.
 *
 * Kept separate from the engine so the arithmetic is testable without a lock,
 * a queue or a database transaction around it — the rules are where the
 * product logic lives, and they are what will be argued about.
 */
@Injectable()
export class DispatchScoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: PlatformSettingsService,
    @Inject(TRAVEL_TIME_PORT) private readonly travel: TravelTimePort,
  ) {}

  async loadSettings(cityId?: string | null): Promise<DispatchSettings> {
    const [
      ackWindowSeconds,
      candidatePoolSize,
      maxAttempts,
      rotationCooldownJobs,
      travelSoftTargetMinutes,
      assumedSpeedKmph,
      ratingPriorMean,
      ratingPriorWeight,
      neighbourMarginKm,
      allowWiden,
    ] = await Promise.all([
      this.settings.getNumber('assignment.ackWindowSeconds', 120, cityId),
      this.settings.getNumber('dispatch.candidatePoolSize', 10, cityId),
      this.settings.getNumber('dispatch.maxAttempts', 3, cityId),
      this.settings.getNumber('rotation.cooldownJobs', 2, cityId),
      this.settings.getNumber('dispatch.travelSoftTargetMinutes', 30, cityId),
      this.settings.getNumber('dispatch.assumedSpeedKmph', 20, cityId),
      this.settings.getNumber('dispatch.ratingPriorMean', 4, cityId),
      this.settings.getNumber('dispatch.ratingPriorWeight', 5, cityId),
      this.settings.getNumber('dispatch.neighbourMarginKm', 1, cityId),
      this.settings.getString('dispatch.allowWidenBeyondArea', 'true', cityId),
    ]);

    return {
      ackWindowSeconds,
      candidatePoolSize,
      maxAttempts,
      rotationCooldownJobs,
      travelSoftTargetMinutes,
      assumedSpeedKmph,
      ratingPriorMean,
      ratingPriorWeight,
      neighbourMarginKm,
      allowWidenBeyondArea: allowWiden !== 'false',
    };
  }

  /**
   * Rule 1's pool: Pros who hold this service, are approved, and are on duty.
   *
   * All three gates are admin-set. An empty result here is a **supply gap**,
   * not a dispatch failure — the caller reports it as `no_supply` (US-5.5).
   *
   * `excludeProIds` is module 7's cash ceiling, and it is passed in rather
   * than queried here so this module never learns what a cash balance is. It
   * applies **only to cash bookings** — a Pro over the ceiling keeps receiving
   * online work, because carrying cash the platform asked them to carry is not
   * a reason to stop paying them (module 7, feature 16).
   *
   * `restrictToProIds` is module 13's area posting, passed in for the same
   * reason. `null` means *do not filter* — nobody is posted to that area, or
   * the booking has no area — and is deliberately different from `[]`, which
   * would exclude everyone.
   */
  findEligiblePros(
    serviceId: string,
    cityId: string | null,
    excludeProIds: string[] = [],
    restrictToProIds: string[] | null = null,
  ): Promise<Pro[]> {
    const now = new Date();

    return this.prisma.pro.findMany({
      where: {
        status: 'approved',
        isAvailable: true,
        /*
         * The Pro's own gate, alongside the admin's.
         *
         * `isAvailable` above says ops rostered them today; this says they
         * have not paused themselves for the next half hour. They are
         * separate columns on purpose — see `ProBreaksService` — and BOTH
         * have to be clear for a Pro to be a candidate.
         *
         * A break ends by the clock passing `breakEndsAt`, so this compares
         * rather than checking a flag: nothing runs to end a break, and a Pro
         * whose app died mid-break returns to this pool on their own.
         */
        OR: [{ breakEndsAt: null }, { breakEndsAt: { lte: now } }],
        ...(cityId ? { cityId } : {}),
        services: { some: { serviceId, isActive: true } },
        ...(excludeProIds.length ? { id: { notIn: excludeProIds } } : {}),
        ...(restrictToProIds ? { id: { in: restrictToProIds } } : {}),
      },
      take: 200,
    });
  }

  /**
   * The Pro's free window around a slot, from **committed bookings alone**.
   * There is no roster — `isAvailable` is a straight on/off flag, so the only
   * thing that occupies time is work already promised.
   *
   * Cached per Pro per day, since a dispatch run evaluates the same Pros for
   * many bookings in quick succession.
   */
  async computeFreeWindow(
    proId: string,
    slotStart: Date,
    slotEnd: Date,
  ): Promise<FreeWindow | null> {
    /*
     * A break the Pro booked ahead occupies the slot exactly as committed
     * work does.
     *
     * This is the half of the break feature that `findEligiblePros` cannot
     * do. That query answers "can this Pro take a job right now"; dispatch
     * also assigns work with a `slotStartAt` hours away, and a Pro who books
     * lunch at 09:00 would otherwise be handed a 13:15 job at 09:05 — long
     * before the break starts, so nothing about their current state stops it.
     * By the time the break begins the job is already theirs.
     *
     * Read straight from the Pro row rather than cached with the bookings
     * below: the cache is keyed per day and a break booked mid-morning has to
     * take effect on the next dispatch run, not after the TTL expires.
     */
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      select: { scheduledBreakStartAt: true, scheduledBreakEndAt: true },
    });

    if (pro?.scheduledBreakStartAt && pro.scheduledBreakEndAt) {
      const breakStart = pro.scheduledBreakStartAt.getTime();
      const breakEnd = pro.scheduledBreakEndAt.getTime();

      // Same half-open overlap test the committed bookings use below.
      if (breakStart < slotEnd.getTime() && breakEnd > slotStart.getTime()) {
        return null;
      }
    }

    const day = slotStart.toISOString().slice(0, 10);
    const cacheKey = `dispatch:freewindows:${proId}:${day}`;

    let committed = await this.readCachedCommitments(cacheKey);
    if (!committed) {
      const dayStart = new Date(`${day}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);
      const bookings = await this.prisma.booking.findMany({
        where: {
          proId,
          status: { in: [...COMMITTED_STATUSES] },
          slotStartAt: { gte: dayStart, lt: dayEnd },
        },
        select: { slotStartAt: true, slotEndAt: true },
        orderBy: { slotStartAt: 'asc' },
      });
      committed = bookings
        .filter((b) => b.slotStartAt && b.slotEndAt)
        .map((b) => ({
          start: b.slotStartAt!.toISOString(),
          end: b.slotEndAt!.toISOString(),
        }));
      await this.redis.set(
        cacheKey,
        JSON.stringify(committed),
        FREE_WINDOW_TTL_SECONDS,
      );
    }

    // Any overlap with committed work means this slot is not free. A Pro
    // cannot be in two places, and overrunning into the next job is exactly
    // the collision US-4.17 warns about.
    const overlaps = committed.some((c) => {
      const start = new Date(c.start).getTime();
      const end = new Date(c.end).getTime();
      return start < slotEnd.getTime() && end > slotStart.getTime();
    });

    return overlaps ? null : { start: slotStart, end: slotEnd };
  }

  /**
   * US-5.7. Where the Pro will be *when this slot starts* — which is the
   * **preceding** committed job's address if there is one, else live GPS, else
   * home base.
   *
   * Note the order and read the query carefully: it finds the latest committed
   * job ending at or before `slotStart`, which is the job *before* this one.
   * That is deliberate and it is what `last_job_location` means. An earlier
   * version of this comment said "the next scheduled job", and the local was
   * named `nextJob` — both wrong, and dangerous, because anyone "fixing" the
   * query to match the name would break origin resolution entirely.
   *
   * The preceding job outranks live GPS on purpose. For a scheduled booking,
   * where the Pro is *now* is irrelevant — what matters is where they will be
   * when they set off. Finishing in one part of the city at 2pm makes them a
   * candidate for jobs near *there* from 2pm, not near their home.
   */
  async resolveOrigin(pro: Pro, slotStart: Date): Promise<TravelOrigin | null> {
    const precedingJob = await this.prisma.booking.findFirst({
      where: {
        proId: pro.id,
        status: { in: [...COMMITTED_STATUSES] },
        slotEndAt: { lte: slotStart },
      },
      orderBy: { slotEndAt: 'desc' },
      include: { address: { select: { pinLat: true, pinLng: true } } },
    });
    if (precedingJob?.address) {
      return {
        originType: 'last_job_location',
        lat: precedingJob.address.pinLat,
        lng: precedingJob.address.pinLng,
      };
    }

    const live = await this.redis.geoPosition(PRO_LIVE_GEO_KEY, pro.id);
    if (live) {
      return {
        originType: 'current_location',
        lat: live.latitude,
        lng: live.longitude,
      };
    }

    if (pro.homeBaseLat != null && pro.homeBaseLng != null) {
      return {
        originType: 'home_base',
        lat: pro.homeBaseLat,
        lng: pro.homeBaseLng,
      };
    }

    return null;
  }

  /**
   * Rule 3. How many of this household's recent jobs this Pro served.
   *
   * The `Booking(addressId, proId, completedAt)` index exists for exactly this
   * query. There is no household-history table — the data is already in
   * `Booking`.
   */
  countRecentJobsAtAddress(
    addressId: string,
    proId: string,
    cooldownJobs: number,
  ): Promise<number> {
    return this.prisma.booking.count({
      where: {
        addressId,
        proId,
        completedAt: { not: null },
      },
      take: Math.max(1, cooldownJobs) * 5,
    });
  }

  /** Offers already pushed to this Pro today — the load-spread tie-break. */
  async countOffersToday(proId: string, now: Date): Promise<number> {
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    return this.prisma.assignmentCandidate.count({
      where: { proId, isWinner: true, evaluatedAt: { gte: dayStart } },
    });
  }

  /**
   * Evaluates one Pro fully. Always returns a row — an excluded Pro gets a
   * reason and a null rank rather than vanishing, because "never a candidate"
   * and "ranked and lost" are different conversations (US-5.11).
   */
  async scoreOne(
    pro: Pro,
    booking: Booking & { address: { pinLat: number; pinLng: number } },
    jobMinutes: number,
    alreadyTried: Set<string>,
    settings: DispatchSettings,
    now: Date,
  ): Promise<ScoredCandidate> {
    const base: ScoredCandidate = {
      proId: pro.id,
      window: null,
      origin: null,
      distanceKm: null,
      travelTimeMinutes: null,
      rotationScore: null,
      durationFitScore: null,
      ratingScore: null,
      offersToday: null,
      finalRankScore: null,
      rank: null,
      excludedReason: null,
    };

    if (alreadyTried.has(pro.id)) {
      return { ...base, excludedReason: 'already_tried' };
    }

    const slotStart = booking.slotStartAt ?? now;
    const slotEnd =
      booking.slotEndAt ?? new Date(slotStart.getTime() + jobMinutes * 60_000);

    const window = await this.computeFreeWindow(pro.id, slotStart, slotEnd);
    if (!window) return { ...base, excludedReason: 'unavailable' };

    const origin = await this.resolveOrigin(pro, slotStart);
    if (!origin) return { ...base, window, excludedReason: 'unavailable' };

    const distanceKm = haversineKm(
      origin.lat,
      origin.lng,
      booking.address.pinLat,
      booking.address.pinLng,
    );
    const travelTimeMinutes = await this.travel.estimateMinutes(
      origin.lat,
      origin.lng,
      booking.address.pinLat,
      booking.address.pinLng,
      settings.assumedSpeedKmph,
    );

    // NO DISTANCE EXCLUSION. There used to be one — anything past
    // `maxTravelMinutes` was dropped as `out_of_range` — and it was an
    // arbitrary number refusing customers a willing Pro could have served
    // (CONFLICTS_AND_DECISIONS #47).
    //
    // Distance still decides most of the ranking; it just no longer decides
    // eligibility. The furthest Pro in the city beats nobody, and the city
    // boundary on `findEligiblePros` is now the only outer bound — a real
    // operational limit rather than a guess applied to a guessed travel time.

    const recentJobs = await this.countRecentJobsAtAddress(
      booking.addressId,
      pro.id,
      settings.rotationCooldownJobs,
    );
    const rotation = rotationScore(recentJobs, settings.rotationCooldownJobs);
    const fit = durationFit(jobMinutes, window) ?? 0;
    const rating = smoothedRating(
      pro.ratingSum,
      pro.ratingCount,
      settings.ratingPriorMean,
      settings.ratingPriorWeight,
    );
    const offersToday = await this.countOffersToday(pro.id, now);

    return {
      ...base,
      window,
      origin,
      distanceKm,
      travelTimeMinutes,
      rotationScore: rotation,
      durationFitScore: fit,
      ratingScore: rating,
      offersToday,
      finalRankScore: finalRankScore({
        travelTimeMinutes,
        travelSoftTargetMinutes: settings.travelSoftTargetMinutes,
        rotationScore: rotation,
        durationFitScore: fit,
        ratingScore: rating,
        offersToday,
      }),
    };
  }

  /**
   * Rule 4's ordering, applied to already-scored candidates.
   *
   * Deterministic all the way down — the last tie-break is the lowest `Pro.id`,
   * so a rerun explains itself the same way it did the first time.
   */
  rank(candidates: ScoredCandidate[]): ScoredCandidate[] {
    const scored = candidates.filter((c) => c.excludedReason === null);

    scored.sort((a, b) => {
      const byScore = (b.finalRankScore ?? 0) - (a.finalRankScore ?? 0);
      if (Math.abs(byScore) > 1e-9) return byScore;
      const byFit = (b.durationFitScore ?? 0) - (a.durationFitScore ?? 0);
      if (Math.abs(byFit) > 1e-9) return byFit;
      const byRating = (b.ratingScore ?? 0) - (a.ratingScore ?? 0);
      if (Math.abs(byRating) > 1e-9) return byRating;
      const byLoad = (a.offersToday ?? 0) - (b.offersToday ?? 0);
      if (byLoad !== 0) return byLoad;
      return a.proId < b.proId ? -1 : a.proId > b.proId ? 1 : 0;
    });

    scored.forEach((c, i) => {
      c.rank = i + 1;
    });

    return scored;
  }

  private async readCachedCommitments(
    key: string,
  ): Promise<Array<{ start: string; end: string }> | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Array<{ start: string; end: string }>;
    } catch {
      // A poisoned cache entry must not take dispatch down — recompute.
      return null;
    }
  }
}
