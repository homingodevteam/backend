import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { BookingCommission } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import type { CommissionPort } from '../bookings/ports/commission.port';
import {
  computeNetPayable,
  computeShares,
  sumRupees,
} from './commission-calculator';
import { COMMISSION_SETTINGS, type CommissionType } from './commission.types';
import { IncentiveEvaluationService } from './incentive-evaluation.service';
import {
  COMMISSION_LEDGER_PORT,
  type CommissionLedgerPort,
} from './ports/commission-ledger.port';

/**
 * Feature 3 — per-booking commission, computed the moment the job completes.
 *
 * The whole module hangs off `recordCompletion`. Everything downstream —
 * earnings, incentives, batches, payouts — reads rows this method wrote, so
 * the two properties that matter here are that it is **idempotent** and that
 * it **snapshots**.
 */
@Injectable()
export class CommissionService implements CommissionPort {
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly incentives: IncentiveEvaluationService,
    @Inject(COMMISSION_LEDGER_PORT)
    private readonly ledger: CommissionLedgerPort,
  ) {}

  /**
   * Compute and store what a completed job earned its Pro.
   *
   * **Idempotent by construction.** `BookingCommission.bookingId` is unique, so
   * the second caller loses the race at the database rather than in a check
   * somebody has to remember — but a unique index alone only converts a double
   * pay into a crash. The advisory lock plus the read-back below turn it into a
   * no-op, which is what the sweeper needs: it re-runs jobs it cannot tell
   * apart from ones already done.
   *
   * **Snapshots the rate.** `commissionType` and `commissionValue` are copied
   * onto the row and the live `Service` row is never consulted again, which is
   * the whole of US-8.3: an admin editing the rate tomorrow cannot restate what
   * was paid yesterday.
   */
  async recordCompletion(bookingId: string, proId: string): Promise<void> {
    const existing = await this.prisma.bookingCommission.findUnique({
      where: { bookingId },
    });
    if (existing) return;

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { service: true },
    });

    if (!booking || booking.status !== 'completed') {
      this.logger.warn(
        `Skipping commission for booking ${bookingId}: it is not completed.`,
      );
      return;
    }

    if (booking.proId !== proId) {
      this.logger.error(
        `Refusing to pay Pro ${proId} for booking ${bookingId}, which is assigned to ${booking.proId ?? 'nobody'}.`,
      );
      return;
    }

    /**
     * US-8.5's edge, and it only *looks* like it contradicts #18.
     *
     * #18 cancelled duration as an input to the *rate*. This is not about the
     * rate — it is about evidence the job happened at all. `startedAt` is set
     * only by a provider-verified OTP or an audited ops force-start, so
     * without it there is no proof the Pro was ever at the customer's door.
     * Module 4 already refuses to complete a job without it; this is the
     * second lock on the same door, because the sweeper reaches rows that did
     * not come through `complete()`.
     */
    if (!booking.startedAt) {
      this.logger.error(
        `Booking ${bookingId} is completed with no verified start — no commission ` +
          'can be computed. This needs a human: either the start was forced ' +
          'without an audit trail, or the row was written outside the lifecycle.',
      );
      return;
    }

    const { commissionType, commissionValue } = booking.service;
    if (!commissionType || commissionValue === null) {
      // US-8.8. Activation is supposed to make this impossible (US-3.11), so
      // reaching it means a service went live without a rate and every
      // completion on it is silently unpaid work.
      this.logger.error(
        `Service ${booking.serviceId} has no commission rate, so booking ` +
          `${bookingId} cannot pay Pro ${proId}. Every completed job on this ` +
          'service is unpaid until a rate is set — then run the sweeper.',
      );
      return;
    }

    const shares = computeShares({
      flatPrice: booking.flatPrice.toString(),
      rate: {
        commissionType: commissionType as CommissionType,
        commissionValue: commissionValue.toString(),
      },
    });

    if (shares.capped) {
      this.logger.error(
        `Commission rate on service ${booking.serviceId} exceeds the job price: ` +
          `booking ${bookingId} pays the Pro the whole ${booking.flatPrice.toString()} ` +
          'and the platform nothing. Check the catalogue rate.',
      );
    }

    let created: BookingCommission | null = null;

    await this.prisma.$transaction(async (tx) => {
      // Serialises the completion hook against the sweeper on the same
      // booking. Without it both read "no row", both compute, and one of them
      // dies on the unique index — turning a benign duplicate into an error
      // the Pro's completion request would have to swallow.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commission:${bookingId}`}, 0))`;

      const raced = await tx.bookingCommission.findUnique({
        where: { bookingId },
      });
      if (raced) return;

      created = await tx.bookingCommission.create({
        data: {
          bookingId,
          proId,
          customerFlatAmount: booking.flatPrice,
          // Recorded because the ERD asks for it. Nothing above read it, and
          // `computeShares` has no parameter that could accept it.
          actualDurationMinutes: booking.actualDurationMinutes,
          commissionType,
          commissionValue,
          commissionAmount: shares.commissionAmount,
          platformAmount: shares.platformAmount,
          incentiveAmount: '0',
          deductionAmount: '0',
          netPayable: shares.commissionAmount,
          status: 'pending',
        },
      });
    });

    if (!created) return;
    const row: BookingCommission = created;

    await this.ledger.recordAccrual({
      commissionId: row.id,
      bookingId,
      proId,
      commissionAmount: shares.commissionAmount,
      platformAmount: shares.platformAmount,
    });

    /**
     * Non-fatal on purpose, and for a narrower reason than the completion
     * hook's. The commission — the money the Pro is actually owed — is
     * committed by this point. Incentive evaluation is a recomputation from
     * source rows that the periodic worker repeats anyway, so losing this run
     * costs a bonus a few minutes of latency, not the job's pay.
     */
    try {
      await this.incentives.evaluateForPro(proId, row.id, new Date());
    } catch (error) {
      this.logger.error(
        `Commission ${row.id} written, but incentive evaluation for Pro ${proId} failed. The periodic pass will retry.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The safety net behind the non-fatal completion hook.
   *
   * Finds completed jobs from the recent past with no commission row and
   * computes them. Without this, "log and carry on" at the call site means a
   * Pro silently loses a job's pay — which is the difference between this and
   * `ProCountersService`, whose nightly rebuild recomputes a statistic.
   *
   * Also the recovery path for US-8.8: set the missing rate, run the sweeper,
   * and every job completed on that service in the window is paid.
   */
  async sweepMissing(): Promise<{ found: number; written: number }> {
    const lookbackHours = await this.settings.getNumber(
      COMMISSION_SETTINGS.SWEEPER_LOOKBACK_HOURS,
      48,
    );
    const since = new Date(Date.now() - lookbackHours * 3_600_000);

    const orphans = await this.prisma.booking.findMany({
      where: {
        status: 'completed',
        completedAt: { gte: since },
        proId: { not: null },
        startedAt: { not: null },
        commission: null,
      },
      select: { id: true, proId: true },
      orderBy: { completedAt: 'asc' },
      // A bound, so a pathological window cannot turn one sweep into an
      // hour-long transaction storm. The next pass takes the rest.
      take: 500,
    });

    let written = 0;
    for (const booking of orphans) {
      if (!booking.proId) continue;
      try {
        await this.recordCompletion(booking.id, booking.proId);
        written += 1;
      } catch (error) {
        this.logger.error(
          `Sweeper could not write commission for booking ${booking.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    if (orphans.length > 0) {
      this.logger.warn(
        `Commission sweeper found ${orphans.length} completed job(s) with no pay row and wrote ${written}.`,
      );
    }

    return { found: orphans.length, written };
  }

  /**
   * Move `pending` rows past the hold window to `approved`.
   *
   * The hold exists for US-8.9's edge: a disputed job under review must not be
   * swept into a payout and then reversed out of it. Anything with a refund in
   * flight stays `pending` and simply waits — it is not an error state, and it
   * needs no queue of its own.
   */
  async approveMatured(): Promise<number> {
    const holdHours = await this.settings.getNumber(
      COMMISSION_SETTINGS.AUTO_APPROVE_AFTER_HOURS,
      24,
    );
    const cutoff = new Date(Date.now() - holdHours * 3_600_000);
    const now = new Date();

    const { count } = await this.prisma.bookingCommission.updateMany({
      where: {
        status: 'pending',
        computedAt: { lte: cutoff },
        booking: {
          // A refund of any size, or a cancellation after the fact, means a
          // human is still deciding. Approving now and reversing later is
          // exactly the churn the hold exists to avoid.
          refundedAmount: null,
          cancelledAt: null,
        },
      },
      data: { status: 'approved', approvedAt: now },
    });

    if (count > 0) {
      this.logger.log(
        `Approved ${count} commission row(s) past the hold window.`,
      );
    }
    return count;
  }

  /** One job's pay, for the Pro who earned it. */
  async getForPro(proId: string, commissionId: string) {
    const row = await this.prisma.bookingCommission.findUnique({
      where: { id: commissionId },
      include: {
        booking: {
          select: {
            bookingNumber: true,
            completedAt: true,
            actualDurationMinutes: true,
            service: { select: { name: true } },
          },
        },
      },
    });

    if (!row || row.proId !== proId) {
      throw apiError('Earning not found', HttpStatus.NOT_FOUND);
    }
    return row;
  }

  /**
   * Recompute `netPayable` and the mirrored `deductionAmount` on a row.
   *
   * `netPayable` is the **per-job** figure the Pro sees on that job. A payout
   * never sums it — it sums `commissionAmount` and `incentiveAmount` and takes
   * deductions from `PayoutDeduction`, which is the only place a deduction is
   * really consumed. Summing both would subtract every deduction twice.
   */
  async refreshTotals(commissionId: string): Promise<void> {
    const row = await this.prisma.bookingCommission.findUnique({
      where: { id: commissionId },
      include: { deductions: { where: { waivedAt: null } } },
    });
    if (!row) return;

    // Through paise, not `Number(...)`. Every money total in this codebase
    // goes the same way, because the one that does not is the one that drifts.
    const deductionAmount = sumRupees(
      row.deductions.map((deduction) => deduction.amount.toString()),
    );

    await this.prisma.bookingCommission.update({
      where: { id: commissionId },
      data: {
        deductionAmount,
        netPayable: computeNetPayable({
          commissionAmount: row.commissionAmount.toString(),
          incentiveAmount: row.incentiveAmount.toString(),
          deductionAmount,
        }),
      },
    });
  }
}
