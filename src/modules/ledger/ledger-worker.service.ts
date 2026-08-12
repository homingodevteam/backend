import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { ReconciliationRunnerService } from './reconciliation-runner.service';

const RUN_LOCK = 'jobs:reconciliation:nightly';

/**
 * Feature 4 — "nightly reconciliation across the whole system".
 *
 * Same pattern as `ProCountersService` and module 8's worker: a
 * self-rescheduling `setTimeout`, `unref`'d so it cannot hold the process open,
 * with a Redis lock so several app instances do not all run it. No new
 * dependency for the sake of a decorator.
 *
 * **02:30 IST**, half an hour after the counter rebuild's own slot, so the two
 * do not contend if that one is still running when this one starts — this job
 * calls `rebuildAll` itself, and the Redis lock inside it makes an overlap
 * harmless rather than merely unlikely.
 */
@Injectable()
export class LedgerWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LedgerWorkerService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly reconciliation: ReconciliationRunnerService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('RECONCILIATION_ENABLED') === 'false') {
      this.logger.warn(
        'Nightly reconciliation disabled. Nothing will cross-check the books or ' +
          'rebuild counters — run POST /admin/reconciliation/run by hand.',
      );
      return;
    }
    this.scheduleNextRun();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Yesterday, in Indian time.
   *
   * A window rather than "everything", because reconciliation walks orders
   * through the gateway and that has a cost per row. Anything older that is
   * still wrong was already reported by the run that covered it, and the
   * discrepancy stays open until somebody closes it.
   */
  async runOnce(): Promise<void> {
    const locked = await this.redis.setIfAbsent(RUN_LOCK, '1', 3600);
    if (!locked) {
      this.logger.log('Another instance is reconciling. Skipping this run.');
      return;
    }

    try {
      const to = new Date();
      const from = new Date(to.getTime() - 24 * 3_600_000);
      const run = await this.reconciliation.run({ scope: 'all', from, to });

      this.logger.log(
        `Reconciliation ${run.status}: ${run.discrepancyCount} discrepancy(ies), ` +
          `${run.totalVarianceAmount.toString()} variance, counters ` +
          `${run.countersRebuilt ? 'rebuilt' : 'not rebuilt'}.`,
      );
    } finally {
      await this.redis.del(RUN_LOCK);
    }
  }

  private scheduleNextRun(): void {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(21, 0, 0, 0); // 02:30 Asia/Kolkata
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch((error: unknown) =>
          this.logger.error(
            `Nightly reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          ),
        )
        .finally(() => this.scheduleNextRun());
    }, next.getTime() - now.getTime());
    this.timer.unref();
  }
}
