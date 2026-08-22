import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { DispatchService } from './dispatch.service';

/**
 * The thing that actually runs dispatch.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Everything else was already built. A booking is created, `enqueue()` pushes
 * its id onto `dispatch:queue`, and `drain()` scores every eligible Pro and
 * writes the winner. What was missing was anything that CALLED `drain()`:
 * before this, its only caller in the whole codebase was
 * `POST /admin/dispatch/drain` — a button an admin had to press.
 *
 * So bookings queued and stayed queued. The symptom was an approved, on-duty
 * Pro who never received a job, and a booking sitting at `assigning`
 * indefinitely with nothing anywhere explaining why.
 *
 * The queue itself is right: booking creation must not block on scoring every
 * Pro in the city (see `RealDispatchAdapter`). It just needed a worker.
 *
 * ---------------------------------------------------------------------------
 * TWO PASSES, AND THE SECOND IS NOT REDUNDANT
 * ---------------------------------------------------------------------------
 * `drainQueue` is the fast path — it empties the Redis list every few seconds.
 *
 * `sweepStranded` is the safety net, and it exists because the queue is a
 * Redis list with no persistence configured. Two ways a booking falls out of
 * it and is never seen again:
 *
 *   - **A restart.** `dispatch:queue` is in memory. Anything queued when Redis
 *     goes down is gone, while the database still says `assigning`.
 *   - **A failed attempt.** `drain()` pops with `LPOP` — destructive — and
 *     catches errors so one poisoned booking cannot stall the queue. That
 *     booking is now out of the list and still unassigned.
 *
 * In both cases the database is the durable record and Redis is the cache, so
 * the sweep reconciles from `Booking.status = 'assigning'` rather than trusting
 * the list. It runs a minute behind the fast path so it only ever picks up what
 * the queue genuinely lost.
 */
@Injectable()
export class DispatchScheduler {
  private readonly logger = new Logger(DispatchScheduler.name);

  /**
   * Guards against a tick starting while the previous one is still running.
   *
   * `drain()` is safe to run concurrently — the per-booking `SET NX PX` lock
   * guarantees that — so overlap cannot double-assign. What it would do is
   * stack slow ticks on a cold database until the pool is exhausted, which is
   * a worse failure than being a few seconds late.
   */
  private draining = false;
  private sweeping = false;

  constructor(
    private readonly dispatch: DispatchService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The fast path. Every five seconds.
   *
   * Fast enough that a customer booking feels instantly assigned, and cheap
   * enough to leave running: an empty queue costs one `LPOP` that returns
   * null, and the method returns without touching Postgres.
   */
  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'dispatch-drain' })
  async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      const results = await this.dispatch.drain();

      // Silent when there was nothing to do — this runs 17,280 times a day and
      // a log line per tick would bury everything else.
      if (results.length) {
        const assigned = results.filter((r) => r.outcome === 'assigned').length;
        this.logger.log(
          `Dispatched ${results.length} booking(s), ${assigned} assigned`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Dispatch drain failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.draining = false;
    }
  }

  /**
   * Acknowledgement deadlines. Every thirty seconds.
   *
   * `expireAcknowledgements` had no caller either, which meant a Pro who
   * ignored an assignment held it for ever: the booking never timed out, never
   * reassigned, and the customer waited on somebody who was not coming.
   *
   * Thirty seconds rather than five because the deadline is minutes long — a
   * job cannot be more than half a minute late being reoffered, and this one
   * does hit Postgres on every tick.
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'dispatch-ack-expiry' })
  async expireAcknowledgements(): Promise<void> {
    try {
      const results = await this.dispatch.expireAcknowledgements();

      if (results.length) {
        this.logger.warn(
          `${results.length} assignment(s) timed out unacknowledged and were reoffered`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Acknowledgement expiry failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The safety net — bookings the queue lost. Every minute.
   *
   * See the note at the top for how a booking ends up here. This asks the
   * durable record rather than the cache: anything still `assigning` with no
   * Pro on it needs another attempt, whatever Redis believes.
   *
   * `run()` rather than `enqueue()`: pushing it back onto the list would work,
   * but running it directly means a booking stranded by a Redis restart is
   * assigned on this tick rather than the next one — and `run()` takes the
   * same per-booking lock, so a race with the fast path resolves rather than
   * double-assigning.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'dispatch-stranded-sweep' })
  async sweepStranded(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;

    try {
      const stranded = await this.prisma.booking.findMany({
        where: { status: 'assigning', proId: null },
        select: { id: true, bookingNumber: true },
        /*
         * Oldest first — a booking that has been waiting longest is the one a
         * customer is most likely to have given up on.
         */
        orderBy: { createdAt: 'asc' },
        take: 25,
      });

      if (!stranded.length) return;

      this.logger.warn(
        `${stranded.length} booking(s) stranded in 'assigning' — the queue lost them`,
      );

      for (const booking of stranded) {
        try {
          await this.dispatch.run(booking.id);
        } catch (error) {
          /*
           * Logged per booking and not rethrown. A booking that cannot be
           * dispatched — no eligible Pro, or already locked by the fast path —
           * must not stop the rest of the sweep, and it will be picked up
           * again next minute.
           */
          this.logger.error(
            `Stranded sweep failed for ${booking.bookingNumber}`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'Stranded sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.sweeping = false;
    }
  }
}
