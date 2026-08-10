import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { AssignmentCandidate } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { BookingStateService } from '../bookings/booking-state.service';
import { ProCountersService } from '../pros/pro-counters.service';
import { DispatchScoringService } from './dispatch-scoring.service';
import type { AssignmentOutcome, ScoredCandidate } from './dispatch.types';

const QUEUE_KEY = 'dispatch:queue';
const LOCK_PREFIX = 'dispatch:lock:';
const LOCK_TTL_SECONDS = 30;

export interface DispatchResult {
  bookingId: string;
  outcome: AssignmentOutcome | 'assigned';
  attemptNumber: number;
  assignedProId?: string;
  candidatesEvaluated: number;
}

/**
 * The engine. Takes a booking, evaluates every eligible Pro, persists why each
 * won or lost, and writes the winner onto the booking.
 *
 * **The assignment lives on `Booking`.** This module owns only
 * `AssignmentCandidate` — the per-attempt audit. That is the v10 decision that
 * removed the `Assignment` table, and its consequence is that "this booking
 * bounced through three Pros" is no longer a single-table read: reconstruct it
 * from `AssignmentCandidate` plus `BookingStatusEvent`.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly scoring: DispatchScoringService,
    private readonly state: BookingStateService,
    private readonly counters: ProCountersService,
  ) {}

  // ------------------------------------------------------------------
  // Queue
  // ------------------------------------------------------------------

  /** One job per booking. Called by module 4 through `DispatchPort`. */
  async enqueue(bookingId: string): Promise<void> {
    await this.redis.listPush(QUEUE_KEY, bookingId);
  }

  async queueDepth(): Promise<number> {
    return this.redis.listLength(QUEUE_KEY);
  }

  /**
   * Drains the queue. Safe to run from anywhere and concurrently — the
   * per-booking lock is what guarantees that, not the caller.
   */
  async drain(max = 25): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];

    for (let i = 0; i < max; i += 1) {
      const bookingId = await this.redis.listPop(QUEUE_KEY);
      if (!bookingId) break;
      try {
        results.push(await this.run(bookingId));
      } catch (error) {
        // One poisoned booking must not stop the queue.
        this.logger.error(
          `Dispatch failed for booking ${bookingId}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return results;
  }

  // ------------------------------------------------------------------
  // The run
  // ------------------------------------------------------------------

  /**
   * One assignment attempt.
   *
   * Guarded by `SET NX PX` on the booking, so a booking can never be
   * double-assigned however many drains, retries or ops clicks land at once.
   */
  async run(bookingId: string): Promise<DispatchResult> {
    const lockKey = `${LOCK_PREFIX}${bookingId}`;
    const acquired = await this.redis.setIfAbsent(
      lockKey,
      'locked',
      LOCK_TTL_SECONDS,
    );
    if (!acquired) {
      throw apiError(
        'This booking is already being dispatched',
        HttpStatus.CONFLICT,
        [
          {
            field: 'bookingId',
            message: 'Another dispatch run holds the lock',
            code: 'DISPATCH_LOCKED',
          },
        ],
      );
    }

    try {
      return await this.attempt(bookingId);
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async attempt(bookingId: string): Promise<DispatchResult> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        address: { select: { pinLat: true, pinLng: true, cityId: true } },
        service: { select: { durationMinutes: true } },
      },
    });
    if (!booking) throw apiError('Booking not found', HttpStatus.NOT_FOUND);

    if (booking.status !== 'assigning') {
      throw apiError(
        `A booking is only dispatchable while assigning (this one is ${booking.status})`,
        HttpStatus.CONFLICT,
      );
    }

    const now = new Date();
    const settings = await this.scoring.loadSettings(booking.address.cityId);
    const attemptNumber = booking.assignmentAttempt + 1;

    if (attemptNumber > settings.maxAttempts) {
      return this.closeUnassignable(bookingId, attemptNumber, 'exhausted', 0);
    }

    const eligible = await this.scoring.findEligiblePros(
      booking.serviceId,
      booking.address.cityId,
    );

    // Nobody holds this service here at all. A structural supply gap, not a
    // per-booking dispatch failure — US-5.5 is explicit that conflating the
    // two gets supply problems triaged as bugs for months.
    if (eligible.length === 0) {
      return this.closeUnassignable(bookingId, attemptNumber, 'no_supply', 0);
    }

    const alreadyTried = await this.previouslyTried(bookingId);

    const scored: ScoredCandidate[] = [];
    for (const pro of eligible) {
      scored.push(
        await this.scoring.scoreOne(
          pro,
          booking,
          booking.service.durationMinutes,
          alreadyTried,
          settings,
          now,
        ),
      );
    }

    const ranked = this.scoring.rank(scored);
    const winner = ranked[0] ?? null;

    await this.persistCandidates(
      bookingId,
      attemptNumber,
      scored,
      ranked,
      winner?.proId ?? null,
      settings.candidatePoolSize,
    );

    if (!winner) {
      return this.closeUnassignable(
        bookingId,
        attemptNumber,
        'exhausted',
        scored.length,
      );
    }

    await this.assign(
      bookingId,
      winner,
      attemptNumber,
      settings.ackWindowSeconds,
    );

    return {
      bookingId,
      outcome: 'assigned',
      attemptNumber,
      assignedProId: winner.proId,
      candidatesEvaluated: scored.length,
    };
  }

  /**
   * Writes the winner onto the booking and opens the acknowledgement window.
   *
   * `notifiedAt` is stamped even though nothing sends yet: the moment
   * Notifications (module 12) exists it hooks in here, and until then the
   * column truthfully records when the Pro *should* have been told.
   */
  private async assign(
    bookingId: string,
    winner: ScoredCandidate,
    attemptNumber: number,
    ackWindowSeconds: number,
  ): Promise<void> {
    const proId = winner.proId;
    const now = new Date();

    await this.state.transition({
      bookingId,
      to: 'assigned',
      actorType: 'system',
      actorId: 'dispatch',
      expectedFrom: ['assigning'],
      data: {
        pro: { connect: { id: proId } },
        assignmentAttempt: attemptNumber,
        assignedAt: now,
        notifiedAt: now,
        ackDeadlineAt: new Date(now.getTime() + ackWindowSeconds * 1000),
        acknowledgedAt: null,
        assignmentOutcome: 'pending_ack',
      },
    });

    // The other caller ProCountersService has been waiting for. Non-fatal for
    // the same reason as completion: counters are derived data rebuilt
    // nightly, and a statistic must not cost a customer their assignment.
    try {
      await this.counters.recordOffer(
        bookingId,
        attemptNumber,
        proId,
        winner.ratingScore ?? undefined,
        winner.offersToday ?? undefined,
      );
    } catch (error) {
      this.logger.error(
        `Booking ${bookingId} assigned, but assignmentsOffered did not increment`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ------------------------------------------------------------------
  // Acknowledgement
  // ------------------------------------------------------------------

  /**
   * US-5.2. Receipt, not agreement — there is no accept and no decline, so
   * this is the only action a Pro has on an assignment.
   */
  async acknowledge(proId: string, bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    // Someone else's booking reads exactly like one that never existed.
    if (!booking || booking.proId !== proId) {
      throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    }

    // Everything else — the window check, the timestamps, the status event,
    // the counter and the acceptance-rate recompute — belongs to the counters
    // service, which does it all inside one advisory-locked transaction and is
    // idempotent via its own marker event.
    //
    // This method deliberately writes nothing itself. An earlier version
    // updated the booking first and *then* called through, which flipped
    // `assignmentOutcome` away from `pending_ack` and made the counter refuse
    // its own work — the same mistake `recordCompletion` already carried.
    await this.counters.recordAcknowledgement(bookingId, proId);
  }

  /**
   * US-5.3. The window expired, so this attempt closes and the next-best
   * candidate is tried — with the silent Pro excluded as `already_tried`.
   *
   * Their acceptance rate moves and their **ranking does not**. The figure is
   * reporting only; penalising rank would punish Pros for undelivered pushes
   * and provider outages.
   */
  async expireAcknowledgements(now = new Date()): Promise<DispatchResult[]> {
    const stale = await this.prisma.booking.findMany({
      where: {
        status: 'assigned',
        assignmentOutcome: 'pending_ack',
        ackDeadlineAt: { lt: now },
      },
      take: 100,
    });

    const results: DispatchResult[] = [];
    for (const booking of stale) {
      try {
        await this.prisma.booking.update({
          where: { id: booking.id },
          data: { assignmentOutcome: 'no_ack_timeout' },
        });
        await this.state.transition({
          bookingId: booking.id,
          to: 'assigning',
          actorType: 'system',
          actorId: 'dispatch',
          expectedFrom: ['assigned'],
          data: { pro: { disconnect: true } },
        });
        results.push(await this.run(booking.id));
      } catch (error) {
        this.logger.error(
          `No-ack retry failed for booking ${booking.id}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return results;
  }

  // ------------------------------------------------------------------
  // Explainability
  // ------------------------------------------------------------------

  /** US-5.9 / US-5.11 — every Pro considered, ranked or excluded. */
  listCandidates(bookingId: string): Promise<AssignmentCandidate[]> {
    return this.prisma.assignmentCandidate.findMany({
      where: { bookingId },
      orderBy: [{ attemptNumber: 'desc' }, { rank: 'asc' }],
    });
  }

  /** US-5.10 / US-5.5 — the ops queue of bookings nobody could take. */
  listUnassignable(): Promise<unknown[]> {
    return this.prisma.booking.findMany({
      where: { assignmentOutcome: { in: ['no_supply', 'exhausted'] } },
      orderBy: { slotStartAt: 'asc' },
      include: {
        assignmentCandidates: { orderBy: [{ attemptNumber: 'desc' }] },
      },
      take: 100,
    });
  }

  // ------------------------------------------------------------------

  private async previouslyTried(bookingId: string): Promise<Set<string>> {
    const winners = await this.prisma.assignmentCandidate.findMany({
      where: { bookingId, isWinner: true },
      select: { proId: true },
    });
    return new Set(winners.map((w) => w.proId));
  }

  /**
   * Every evaluated Pro gets a row — the ranked ones capped at the configured
   * pool size, and **all** excluded ones, because "why wasn't this Pro
   * chosen?" is asked about exclusions more often than about runners-up.
   */
  private async persistCandidates(
    bookingId: string,
    attemptNumber: number,
    all: ScoredCandidate[],
    ranked: ScoredCandidate[],
    winnerProId: string | null,
    poolSize: number,
  ): Promise<void> {
    const keep = new Set(ranked.slice(0, poolSize).map((c) => c.proId));
    const rows = all.filter(
      (c) => c.excludedReason !== null || keep.has(c.proId),
    );

    await this.prisma.assignmentCandidate.createMany({
      data: rows.map((c) => ({
        bookingId,
        attemptNumber,
        proId: c.proId,
        isWinner: c.proId === winnerProId,
        windowStart: c.window?.start ?? null,
        windowEnd: c.window?.end ?? null,
        originType: c.origin?.originType ?? null,
        originLat: c.origin?.lat ?? null,
        originLng: c.origin?.lng ?? null,
        rank: c.rank,
        distanceKm: c.distanceKm,
        travelTimeMinutes: c.travelTimeMinutes,
        rotationScore: c.rotationScore,
        durationFitScore: c.durationFitScore,
        ratingScore: c.ratingScore,
        offersToday: c.offersToday,
        finalRankScore: c.finalRankScore,
        excludedReason: c.excludedReason,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * No winner. The booking stays in `assigning` — it is not cancelled, because
   * a customer waiting is a supply problem for ops to solve, not an error to
   * throw away. US-5.10's alert must fire *before* the slot time; by the slot
   * time it is already a failure.
   */
  private async closeUnassignable(
    bookingId: string,
    attemptNumber: number,
    outcome: 'no_supply' | 'exhausted',
    candidatesEvaluated: number,
  ): Promise<DispatchResult> {
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { assignmentAttempt: attemptNumber, assignmentOutcome: outcome },
    });
    await this.state.recordEvent(bookingId, outcome, 'system', 'dispatch');

    this.logger.warn(
      `Booking ${bookingId} is unassignable (${outcome}) after attempt ${attemptNumber}`,
    );

    return { bookingId, outcome, attemptNumber, candidatesEvaluated };
  }
}
