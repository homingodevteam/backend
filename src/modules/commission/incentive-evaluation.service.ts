import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Incentive, ProIncentiveProgress } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sumRupees } from './commission-calculator';
import {
  type IncentiveRecurrence,
  type IncentiveType,
  hasEvaluator,
} from './commission.types';
import { evaluate, parseCriteria } from './incentive-evaluators';
import { periodFor, type IncentivePeriod } from './incentive-periods';
import {
  COMMISSION_LEDGER_PORT,
  type CommissionLedgerPort,
} from './ports/commission-ledger.port';

/**
 * Feature 7 — incentive progress tracked per Pro, credited against the job
 * that triggered it.
 *
 * **Derived from source, not incremented.** Every run rebuilds a period's
 * contributions from the commission and review rows that actually exist, then
 * takes progress to be their sum. Incrementing a counter would be cheaper and
 * would drift the first time a completion was retried, a reversal landed, or a
 * review arrived late — and drift here is a bonus paid or withheld wrongly.
 *
 * Being a recomputation is also what lets the same method serve three callers
 * with no coordination between them: the completion hook, the periodic pass,
 * and a reversal. Running it twice changes nothing.
 */
@Injectable()
export class IncentiveEvaluationService {
  private readonly logger = new Logger(IncentiveEvaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(COMMISSION_LEDGER_PORT)
    private readonly ledger: CommissionLedgerPort,
  ) {}

  /**
   * Bring every incentive this Pro is eligible for up to date as of `at`.
   *
   * `triggeringCommissionId` is where a newly earned reward gets credited. When
   * it is absent — the periodic pass, or an unwind — the most recent
   * contributing job is used instead, so a reward always has a job to hang off
   * and a reversal always has something to follow back.
   */
  async evaluateForPro(
    proId: string,
    triggeringCommissionId: string | null,
    at: Date,
  ): Promise<void> {
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      select: { id: true, cityId: true },
    });
    if (!pro) return;

    const incentives = await this.prisma.incentive.findMany({
      where: {
        isActive: true,
        validFrom: { lte: at },
        OR: [{ validTo: null }, { validTo: { gt: at } }],
        // Null city = platform-wide.
        ...(pro.cityId
          ? { AND: [{ OR: [{ cityId: null }, { cityId: pro.cityId }] }] }
          : { cityId: null }),
      },
    });

    for (const incentive of incentives) {
      if (!hasEvaluator(incentive.incentiveType)) continue;
      try {
        await this.evaluateOne(proId, incentive, triggeringCommissionId, at);
      } catch (error) {
        // One malformed scheme must not stop the others from crediting.
        this.logger.error(
          `Incentive ${incentive.id} could not be evaluated for Pro ${proId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private async evaluateOne(
    proId: string,
    incentive: Incentive,
    triggeringCommissionId: string | null,
    at: Date,
  ): Promise<void> {
    const period = periodFor(incentive.recurrence as IncentiveRecurrence, at);
    // The scheme's own validity clips the period, so a scheme starting
    // mid-month does not count the fortnight before it existed.
    const windowStart =
      incentive.validFrom > period.start ? incentive.validFrom : period.start;
    const windowEnd =
      incentive.validTo && incentive.validTo < period.end
        ? incentive.validTo
        : period.end;

    const criteria = parseCriteria(
      incentive.incentiveType as IncentiveType,
      incentive.criteriaJson,
    );
    if (criteria === null) return;

    const progress = await this.upsertProgress(proId, incentive, period);

    // Already won this period. Recomputing contributions would be harmless,
    // but re-crediting would not, and there is nothing left to decide.
    if (progress.rewardCredited) return;

    const contributions = await this.deriveContributions(
      proId,
      incentive.incentiveType as IncentiveType,
      windowStart,
      windowEnd,
    );

    await this.syncContributions(progress.id, contributions);

    const progressValue = sumRupees(contributions.map((c) => c.value));
    const verdict = evaluate(
      incentive.incentiveType as IncentiveType,
      criteria,
      {
        contributionCount: contributions.length,
        progressValue,
      },
    );
    if (!verdict) return;

    if (!verdict.achieved) {
      await this.prisma.proIncentiveProgress.update({
        where: { id: progress.id },
        data: {
          progressValue,
          targetValue: verdict.targetValue,
          achievedAt: null,
        },
      });
      return;
    }

    // The job the reward hangs off. Prefer the one that triggered this run;
    // fall back to the newest contributor, which is the same job in every case
    // except a late-arriving review or a periodic pass.
    const creditAgainst =
      triggeringCommissionId &&
      contributions.some((c) => c.commissionId === triggeringCommissionId)
        ? triggeringCommissionId
        : contributions[contributions.length - 1]?.commissionId;

    if (!creditAgainst) return;

    await this.credit(progress.id, proId, incentive, creditAgainst, {
      progressValue,
      targetValue: verdict.targetValue,
      at,
    });
  }

  private async upsertProgress(
    proId: string,
    incentive: Incentive,
    period: IncentivePeriod,
  ): Promise<ProIncentiveProgress> {
    return this.prisma.proIncentiveProgress.upsert({
      where: {
        proId_incentiveId_periodKey: {
          proId,
          incentiveId: incentive.id,
          periodKey: period.key,
        },
      },
      update: {},
      create: {
        proId,
        incentiveId: incentive.id,
        periodKey: period.key,
        periodStart: period.start,
        periodEnd: period.end,
        progressValue: '0',
        // Replaced by the evaluator's own figure a moment later; a placeholder
        // is needed because the column is NOT NULL and the row must exist
        // before contributions can point at it.
        targetValue: '0',
      },
    });
  }

  /**
   * What actually counted, read back out of the rows that prove it.
   *
   * `jobs_count` counts completed, non-reversed jobs. `rating` counts the same
   * jobs, but only those the customer has since rated, and carries the stars
   * as the value — which is why a rating scheme fills in over the days after
   * the work, and why the periodic pass exists rather than the completion hook
   * being the only trigger.
   */
  private async deriveContributions(
    proId: string,
    incentiveType: IncentiveType,
    from: Date,
    to: Date,
  ): Promise<{ commissionId: string; value: string }[]> {
    const commissions = await this.prisma.bookingCommission.findMany({
      where: {
        proId,
        status: { not: 'reversed' },
        computedAt: { gte: from, lt: to },
      },
      select: {
        id: true,
        booking: {
          select: {
            /**
             * `reviewerType: 'customer'` is load-bearing, not defensive.
             *
             * Module 10 gave a booking a second review — the Pro's rating of
             * the customer — in the same table. A rating incentive counts what
             * the **customer** thought of the work; without this filter a Pro
             * could hit a five-star bonus by rating their own customers five
             * stars. Same root cause as CONFLICTS_AND_DECISIONS #61: one table,
             * two directions, and `reviewerType` the only thing separating
             * them.
             */
            reviews: {
              where: { reviewerType: 'customer' },
              select: { rating: true },
              take: 1,
            },
          },
        },
      },
      orderBy: { computedAt: 'asc' },
    });

    if (incentiveType === 'jobs_count') {
      return commissions.map((row) => ({ commissionId: row.id, value: '1' }));
    }

    return commissions
      .filter((row) => row.booking.reviews.length > 0)
      .map((row) => ({
        commissionId: row.id,
        value: String(row.booking.reviews[0]?.rating ?? 0),
      }));
  }

  /**
   * Make the stored contributions match what was just derived.
   *
   * Deletes first: a job that has been reversed since the last run must stop
   * counting, and this is the only place that happens. The unique index on
   * (progress, commission) makes the create side safe to repeat.
   */
  private async syncContributions(
    progressId: string,
    derived: { commissionId: string; value: string }[],
  ): Promise<void> {
    const keep = derived.map((row) => row.commissionId);

    await this.prisma.proIncentiveContribution.deleteMany({
      where: {
        progressId,
        ...(keep.length > 0 ? { commissionId: { notIn: keep } } : {}),
      },
    });

    if (derived.length === 0) return;

    await this.prisma.proIncentiveContribution.createMany({
      data: derived.map((row) => ({
        progressId,
        commissionId: row.commissionId,
        value: row.value,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Pay the bonus onto the triggering job's commission row.
   *
   * The reward amount is **snapshotted** onto the progress row for the same
   * reason the commission rate is: editing the scheme next week must not
   * restate a bonus already earned.
   */
  private async credit(
    progressId: string,
    proId: string,
    incentive: Incentive,
    commissionId: string,
    totals: { progressValue: string; targetValue: string; at: Date },
  ): Promise<void> {
    const reward = incentive.rewardAmount.toString();

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`incentive:${progressId}`}, 0))`;

      const current = await tx.proIncentiveProgress.findUnique({
        where: { id: progressId },
      });
      // Another pass got there first. Crediting again would pay the bonus
      // twice off one achievement.
      if (!current || current.rewardCredited) return;

      await tx.proIncentiveProgress.update({
        where: { id: progressId },
        data: {
          progressValue: totals.progressValue,
          targetValue: totals.targetValue,
          achievedAt: totals.at,
          rewardCredited: true,
          rewardAmount: reward,
          commissionId,
        },
      });

      const commission = await tx.bookingCommission.findUnique({
        where: { id: commissionId },
      });
      if (!commission) return;

      const incentiveAmount = sumRupees([
        commission.incentiveAmount.toString(),
        reward,
      ]);

      await tx.bookingCommission.update({
        where: { id: commissionId },
        data: {
          incentiveAmount,
          netPayable: sumRupees([
            commission.commissionAmount.toString(),
            incentiveAmount,
          ]),
        },
      });
    });

    await this.ledger.recordIncentiveCredit({
      commissionId,
      proId,
      incentiveId: incentive.id,
      amount: reward,
    });

    this.logger.log(
      `Incentive "${incentive.name}" credited ${reward} against commission ${commissionId}.`,
    );
  }

  /**
   * Unwind whatever a now-reversed job contributed.
   *
   * Two distinct jobs, and the second is the one that is easy to miss:
   *
   * 1. Drop its contributions, so the progress it propped up falls back. The
   *    contribution rows are what make this possible at all — a single
   *    `commissionId` on the progress row would only ever have named the job
   *    that tipped it over, leaving the other forty-nine untraceable.
   * 2. If the bonus was already **credited against that job**, the reward has
   *    to come back too. Where it comes back from depends on whether the money
   *    has left, which is the caller's problem — this returns what is owed and
   *    lets `CommissionReversalService` decide.
   */
  async unwindForCommission(
    commissionId: string,
  ): Promise<
    { progressId: string; incentiveName: string; rewardAmount: string }[]
  > {
    const contributions = await this.prisma.proIncentiveContribution.findMany({
      where: { commissionId },
      select: { progressId: true },
    });

    await this.prisma.proIncentiveContribution.deleteMany({
      where: { commissionId },
    });

    const creditedHere = await this.prisma.proIncentiveProgress.findMany({
      where: { commissionId, rewardCredited: true },
      include: { incentive: { select: { name: true, rewardAmount: true } } },
    });

    const owed: {
      progressId: string;
      incentiveName: string;
      rewardAmount: string;
    }[] = [];

    for (const progress of creditedHere) {
      owed.push({
        progressId: progress.id,
        incentiveName: progress.incentive.name,
        // The snapshot, not the scheme's current value — the same reason the
        // commission rate is snapshotted. Recovering today's ₹2,000 for a
        // bonus that paid ₹1,500 in March would be taking money that was
        // never given.
        rewardAmount: (
          progress.rewardAmount ?? progress.incentive.rewardAmount
        ).toString(),
      });

      await this.prisma.proIncentiveProgress.update({
        where: { id: progress.id },
        data: {
          rewardCredited: false,
          rewardAmount: null,
          achievedAt: null,
          commissionId: null,
        },
      });
    }

    // Recount every progress row the reversed job touched, so the bar the Pro
    // sees matches the jobs that are still standing.
    const touched = new Set(contributions.map((row) => row.progressId));
    for (const progressId of touched) {
      await this.recount(progressId);
    }

    return owed;
  }

  /** Re-derive `progressValue` from the contributions that remain. */
  private async recount(progressId: string): Promise<void> {
    const remaining = await this.prisma.proIncentiveContribution.findMany({
      where: { progressId },
      select: { value: true },
    });

    await this.prisma.proIncentiveProgress.update({
      where: { id: progressId },
      data: {
        progressValue: sumRupees(remaining.map((row) => row.value.toString())),
      },
    });
  }
}
