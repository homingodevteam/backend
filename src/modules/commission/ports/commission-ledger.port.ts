import { Injectable, Logger } from '@nestjs/common';

/**
 * Deliberately **not** `LEDGER_PORT`.
 *
 * Module 7 already exports a symbol with that name. A second one would be a
 * different symbol carrying the same label, which compiles, works, and leaves
 * the next person reading `@Inject(LEDGER_PORT)` with no way to tell which of
 * the two they are looking at. The entries are different too — module 7 records
 * a charge, this records an accrual and a disbursement — so sharing the port
 * would make module 8 depend on module 7 for nothing but a name.
 *
 * When module 9 lands it registers into both delegates, which is the pattern
 * this codebase has used three times already.
 */
export const COMMISSION_LEDGER_PORT = Symbol('COMMISSION_LEDGER_PORT');

export interface CommissionAccrualEntry {
  commissionId: string;
  bookingId: string;
  proId: string;
  /** What the Pro earned. */
  commissionAmount: string;
  /** What the platform kept. */
  platformAmount: string;
}

export interface IncentiveCreditEntry {
  commissionId: string;
  proId: string;
  incentiveId: string;
  amount: string;
}

export interface CommissionReversalEntry {
  commissionId: string;
  proId: string;
  amount: string;
  /**
   * Bonus credited against this job that is being unwound with it. Needs its
   * own leg, because it was booked against a different expense account.
   */
  incentiveAmount: string;
  /** True when the money had already left, so a deduction was raised instead. */
  alreadyPaid: boolean;
  reason: string;
}

export interface DeductionRecoveredEntry {
  deductionId: string;
  proId: string;
  payoutId: string;
  amount: string;
  reason: string;
}

export interface PayoutDisbursementEntry {
  payoutId: string;
  proId: string;
  netAmount: string;
  payoutReference: string;
}

/**
 * What Commission needs from the Ledger (module 9), expressed as an interface
 * Commission owns.
 *
 * Every method is the point where a double-entry pair would be written. Fails
 * **quietly**: by the time any of these is called the decision has already been
 * recorded in this module's own tables, and refusing to complete a payout
 * because module 9 is absent would be the worse outcome. What is lost is the
 * audit trail, and it is rebuildable from `BookingCommission`,
 * `CommissionPayout` and `PayoutDeduction` — which is what module 9's
 * reconciliation is for.
 */
export interface CommissionLedgerPort {
  recordAccrual(entry: CommissionAccrualEntry): Promise<void>;
  recordIncentiveCredit(entry: IncentiveCreditEntry): Promise<void>;
  recordReversal(entry: CommissionReversalEntry): Promise<void>;
  /**
   * A deduction actually taken out of a payout that has been paid.
   *
   * Called at **settlement**, not when the deduction is raised or claimed. A
   * raised deduction is a claim, not a movement — and a batch that is rejected
   * gives its claims back, which would leave an entry in an append-only table
   * describing money that never moved.
   */
  recordDeductionRecovered(entry: DeductionRecoveredEntry): Promise<void>;
  recordDisbursement(entry: PayoutDisbursementEntry): Promise<void>;
}

@Injectable()
export class NoOpCommissionLedgerService implements CommissionLedgerPort {
  private readonly logger = new Logger(NoOpCommissionLedgerService.name);

  /** The real ledger, registered at boot by module 9 if it is present. */
  private real: CommissionLedgerPort | null = null;

  register(implementation: CommissionLedgerPort): void {
    this.real = implementation;
    this.logger.log('Ledger registered — commission movements are now booked.');
  }

  recordAccrual(entry: CommissionAccrualEntry): Promise<void> {
    if (this.real) return this.real.recordAccrual(entry);
    return this.note(
      `accrue ${entry.commissionAmount} to pro ${entry.proId} and ` +
        `${entry.platformAmount} to the platform for booking ${entry.bookingId}`,
    );
  }

  recordIncentiveCredit(entry: IncentiveCreditEntry): Promise<void> {
    if (this.real) return this.real.recordIncentiveCredit(entry);
    return this.note(
      `credit incentive ${entry.incentiveId} of ${entry.amount} to pro ` +
        `${entry.proId} against commission ${entry.commissionId}`,
    );
  }

  recordReversal(entry: CommissionReversalEntry): Promise<void> {
    if (this.real) return this.real.recordReversal(entry);
    return this.note(
      `reverse ${entry.amount} on commission ${entry.commissionId} for pro ` +
        `${entry.proId}${entry.alreadyPaid ? ' (already paid — carried as a deduction)' : ''}`,
    );
  }

  recordDeductionRecovered(entry: DeductionRecoveredEntry): Promise<void> {
    if (this.real) return this.real.recordDeductionRecovered(entry);
    return this.note(
      `recover ${entry.amount} from pro ${entry.proId} in payout ${entry.payoutId} ` +
        `(deduction ${entry.deductionId})`,
    );
  }

  recordDisbursement(entry: PayoutDisbursementEntry): Promise<void> {
    if (this.real) return this.real.recordDisbursement(entry);
    return this.note(
      `disburse ${entry.netAmount} to pro ${entry.proId} as payout ` +
        `${entry.payoutId} (${entry.payoutReference})`,
    );
  }

  private note(what: string): Promise<void> {
    this.logger.warn(
      `Ledger entry not written — module 9 is not built: ${what}`,
    );
    return Promise.resolve();
  }
}
