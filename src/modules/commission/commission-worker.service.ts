import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CommissionService } from './commission.service';
import { IncentiveEvaluationService } from './incentive-evaluation.service';

const WORKER_LOCK = 'jobs:commission:pass';

/**
 * The three unattended passes this module needs, on a timer.
 *
 * **No new dependency.** `@nestjs/schedule` is not in this codebase and
 * `ProCountersService` already establishes the pattern for periodic work: a
 * self-rescheduling `setTimeout`, `unref`'d so it cannot hold the process open,
 * with a Redis lock so several app instances do not all run the same pass.
 * Adding a scheduling library to gain a decorator would put a new line in
 * `package.json` — one of the two files that conflicts hardest between parallel
 * branches — for no behaviour this does not already have.
 *
 * Every pass is also reachable as an admin endpoint. A background job nobody
 * can trigger is a background job nobody can test.
 */
@Injectable()
export class CommissionWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommissionWorkerService.name);
  private timer?: NodeJS.Timeout;

  /**
   * Fifteen minutes. The sweeper is a safety net rather than the main path, and
   * the hold window it interacts with is measured in hours — running every
   * minute would add load to answer a question whose answer changes hourly.
   */
  private static readonly INTERVAL_MS = 15 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly commissions: CommissionService,
    private readonly incentives: IncentiveEvaluationService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('COMMISSION_WORKER_ENABLED') === 'false') {
      this.logger.warn(
        'Commission worker disabled. The sweeper, the approval pass and late ' +
          'rating incentives will not run — trigger them from the admin routes.',
      );
      return;
    }
    this.schedule();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * One pass, in the order the passes depend on each other.
   *
   * Sweep first, so a job that never got a commission row has one before
   * anything tries to approve it. Approve second. Rating incentives last,
   * because a review that arrived hours after the job is the one thing the
   * completion hook cannot have seen.
   */
  async runOnce(): Promise<void> {
    const locked = await this.redis.setIfAbsent(WORKER_LOCK, '1', 600);
    if (!locked) return;

    try {
      await this.commissions.sweepMissing();
      await this.commissions.approveMatured();
      await this.reevaluateRecentEarners();
    } finally {
      await this.redis.del(WORKER_LOCK);
    }
  }

  /**
   * Re-run incentive evaluation for anyone who has finished a job lately.
   *
   * The case this exists for: a `rating` scheme cannot be settled at completion
   * because the customer has not rated the job yet. Reviews arrive over the
   * following days, and without this pass a Pro would hold a 4.8 average across
   * forty jobs and never be credited the bonus for it.
   *
   * Bounded to Pros with recent activity rather than sweeping everybody — the
   * question only has a new answer for someone who has worked.
   */
  private async reevaluateRecentEarners(): Promise<void> {
    const since = new Date(Date.now() - 14 * 24 * 3_600_000);

    const earners = await this.prisma.bookingCommission.groupBy({
      by: ['proId'],
      where: { computedAt: { gte: since }, status: { not: 'reversed' } },
      orderBy: { proId: 'asc' },
      take: 500,
    });

    for (const earner of earners) {
      try {
        await this.incentives.evaluateForPro(earner.proId, null, new Date());
      } catch (error) {
        this.logger.error(
          `Periodic incentive evaluation failed for Pro ${earner.proId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch((error: unknown) =>
          this.logger.error(
            `Commission worker pass failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          ),
        )
        .finally(() => this.schedule());
    }, CommissionWorkerService.INTERVAL_MS);
    this.timer.unref();
  }
}
