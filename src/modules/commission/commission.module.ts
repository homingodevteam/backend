import { Inject, Logger, Module, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildRazorpayXOptions,
  type RazorpayXOptions,
} from '../../config/razorpayx.config';
import { RedisModule } from '../../redis/redis.module';
import { BookingsModule } from '../bookings/bookings.module';
import {
  COMMISSION_PORT,
  NoOpCommissionService,
} from '../bookings/ports/commission.port';
import { IdentityModule } from '../identity/identity.module';
import { PaymentsModule } from '../payments/payments.module';
import {
  COMMISSION_REVERSAL_PORT,
  NoOpCommissionReversalService,
} from '../payments/ports/commission-reversal.port';
import { AdminCommissionController } from './admin-commission.controller';
import { AdminIncentivesController } from './admin-incentives.controller';
import { AdminPayoutsController } from './admin-payouts.controller';
import { CommissionAdminService } from './commission-admin.service';
import { CommissionReversalService } from './commission-reversal.service';
import { CommissionService } from './commission.service';
import { CommissionWorkerService } from './commission-worker.service';
import { DeductionsService } from './deductions.service';
import { IncentiveEvaluationService } from './incentive-evaluation.service';
import { IncentivesService } from './incentives.service';
import { PayoutBatchService } from './payout-batch.service';
import { PayoutDisbursementService } from './payout-disbursement.service';
import { PayoutWebhookController } from './payout-webhook.controller';
import { PayoutWebhookService } from './payout-webhook.service';
import {
  COMMISSION_LEDGER_PORT,
  NoOpCommissionLedgerService,
} from './ports/commission-ledger.port';
import { ProEarningsController } from './pro-earnings.controller';
import { ProEarningsService } from './pro-earnings.service';
import { RAZORPAYX_OPTIONS, RazorpayXClient } from './razorpayx.client';

/**
 * Module 8 · Commission & Payouts — the only Pro compensation this system
 * calculates.
 *
 * Owns `BookingCommission`, `CommissionPayout`, `Incentive`,
 * `ProIncentiveProgress`, `ProIncentiveContribution` and `PayoutDeduction`.
 *
 * ## Registration, not import
 *
 * **Registers itself into two delegates at boot** — module 4's
 * {@link COMMISSION_PORT} and module 7's {@link COMMISSION_REVERSAL_PORT} — the
 * same way module 5 does for dispatch and module 7 does for payments. Nest
 * resolves providers per module, so re-binding either symbol here would never
 * reach `BookingLifecycleService` or `RefundsService`; making those modules
 * import this one would invert the very dependency the ports exist to prevent.
 *
 * Unlike module 7, registration is **not** conditional on credentials.
 * Computing what a Pro earned needs no gateway, and a deployment without
 * RazorpayX must still record every rupee owed — it simply cannot send it.
 *
 * ## What does not exist yet
 *
 * - {@link COMMISSION_LEDGER_PORT} → module 9. Logs and returns. Deliberately
 *   not module 7's `LEDGER_PORT`: two symbols with the same name are
 *   indistinguishable at an `@Inject` site.
 * - Payout failure notifications → module 12. `status = failed` is set and
 *   visible in the app; nothing is pushed.
 *
 * ## Salary
 *
 * Out of scope by decision, not oversight. `Pro.monthlySalary` is bookkeeping;
 * payroll pays it. Disbursing salary would make this a payroll system, and
 * payroll in India carries TDS, PF, ESI and statutory registers none of which
 * is modelled here. Every earnings response therefore carries `salaryNote`.
 */
@Module({
  imports: [IdentityModule, BookingsModule, PaymentsModule, RedisModule],
  controllers: [
    ProEarningsController,
    AdminCommissionController,
    AdminIncentivesController,
    AdminPayoutsController,
    PayoutWebhookController,
  ],
  providers: [
    {
      provide: RAZORPAYX_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RazorpayXOptions | undefined =>
        buildRazorpayXOptions({
          NODE_ENV: config.get<string>('NODE_ENV'),
          RAZORPAYX_KEY_ID: config.get<string>('RAZORPAYX_KEY_ID'),
          RAZORPAYX_KEY_SECRET: config.get<string>('RAZORPAYX_KEY_SECRET'),
          RAZORPAYX_WEBHOOK_SECRET: config.get<string>(
            'RAZORPAYX_WEBHOOK_SECRET',
          ),
          RAZORPAYX_ACCOUNT_NUMBER: config.get<string>(
            'RAZORPAYX_ACCOUNT_NUMBER',
          ),
          RAZORPAYX_BASE_URL: config.get<string>('RAZORPAYX_BASE_URL'),
        }),
    },
    RazorpayXClient,
    CommissionService,
    CommissionAdminService,
    CommissionReversalService,
    CommissionWorkerService,
    DeductionsService,
    IncentivesService,
    IncentiveEvaluationService,
    PayoutBatchService,
    PayoutDisbursementService,
    PayoutWebhookService,
    ProEarningsService,
    { provide: COMMISSION_LEDGER_PORT, useClass: NoOpCommissionLedgerService },
  ],
  // Module 9 registers the real ledger into the delegate below.
  exports: [CommissionService, DeductionsService, COMMISSION_LEDGER_PORT],
})
export class CommissionModule {
  private readonly logger = new Logger(CommissionModule.name);

  constructor(
    @Inject(COMMISSION_PORT) completions: NoOpCommissionService,
    @Inject(COMMISSION_REVERSAL_PORT) refunds: NoOpCommissionReversalService,
    commissions: CommissionService,
    reversals: CommissionReversalService,
    @Optional()
    @Inject(RAZORPAYX_OPTIONS)
    options?: RazorpayXOptions,
  ) {
    completions.register(commissions);
    refunds.register(reversals);

    if (!options) {
      this.logger.warn(
        'RazorpayX is not configured — commissions, incentives, batches and ' +
          'approval all work, but no payout can be sent. Set RAZORPAYX_KEY_ID, ' +
          'RAZORPAYX_KEY_SECRET, RAZORPAYX_WEBHOOK_SECRET and ' +
          'RAZORPAYX_ACCOUNT_NUMBER to enable disbursement.',
      );
    }
  }
}
