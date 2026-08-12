import { Inject, Logger, Module } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module';
import {
  COMMISSION_LEDGER_PORT,
  NoOpCommissionLedgerService,
} from '../commission/ports/commission-ledger.port';
import { CommissionModule } from '../commission/commission.module';
import { IdentityModule } from '../identity/identity.module';
import { PaymentsModule } from '../payments/payments.module';
import { LEDGER_PORT, NoOpLedgerService } from '../payments/ports/ledger.port';
import { ProsModule } from '../pros/pros.module';
import { AdminLedgerController } from './admin-ledger.controller';
import { LedgerAdapterService } from './ledger-adapter.service';
import { LedgerBalancesService } from './ledger-balances.service';
import { LedgerService } from './ledger.service';
import { LedgerWorkerService } from './ledger-worker.service';
import { ReconciliationRunnerService } from './reconciliation-runner.service';

/**
 * Module 9 · Ledger & Reconciliation — the books.
 *
 * Owns `LedgerEntry`, `ReconciliationRun` and `ReconciliationDiscrepancy`.
 *
 * ## This module writes no business logic
 *
 * Every event that should produce an entry already existed as a typed call
 * into a no-op port — four in module 7, four in module 8. `LedgerAdapterService`
 * fills them in and does nothing else; the only decision it makes is which two
 * accounts a movement is between.
 *
 * **Registers into both delegates at boot**, the pattern this codebase has now
 * used four times. Neither module 7 nor module 8 imports this one, and neither
 * changes when it appears.
 *
 * ## Reconciliation extends rather than replaces
 *
 * Module 7's `ReconciliationService` already answers the money and cash
 * questions and throws the answers away; module 6's
 * `ProCountersService.rebuildAll` already rebuilds the derived counters.
 * `ReconciliationRunnerService` records the first and calls the second, then
 * adds the checks that only make sense once a ledger exists. Reimplementing
 * either would have produced a second answer free to disagree with the first.
 *
 * ## Nothing here corrects anything
 *
 * Not the ledger — the table refuses `UPDATE` and `DELETE` at the database.
 * Not the source rows either: a discrepancy is a question for a human, and
 * silently making our row match the gateway's would destroy the only evidence
 * that they ever differed.
 */
@Module({
  imports: [
    IdentityModule,
    PaymentsModule,
    CommissionModule,
    ProsModule,
    RedisModule,
  ],
  controllers: [AdminLedgerController],
  providers: [
    LedgerService,
    LedgerAdapterService,
    LedgerBalancesService,
    ReconciliationRunnerService,
    LedgerWorkerService,
  ],
  exports: [LedgerService, LedgerBalancesService],
})
export class LedgerModule {
  private readonly logger = new Logger(LedgerModule.name);

  constructor(
    @Inject(LEDGER_PORT) payments: NoOpLedgerService,
    @Inject(COMMISSION_LEDGER_PORT) commission: NoOpCommissionLedgerService,
    adapter: LedgerAdapterService,
  ) {
    /**
     * Unconditional, unlike module 7's gateway registration.
     *
     * There is no credential to be absent and no external service to be
     * unreachable — the books are a table. A deployment where this did not
     * register would be one that takes money and does not write it down.
     */
    payments.register(adapter);
    commission.register(adapter);

    this.logger.log(
      'Ledger registered — every money movement in modules 7 and 8 is now booked.',
    );
  }
}
