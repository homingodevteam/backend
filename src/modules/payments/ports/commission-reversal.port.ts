import { Injectable, Logger } from '@nestjs/common';

export const COMMISSION_REVERSAL_PORT = Symbol('COMMISSION_REVERSAL_PORT');

export interface RefundReversalNotice {
  bookingId: string;
  /** Rupees refunded on this action. */
  amount: string;
  /** True when the whole captured amount has now been returned. */
  isFullRefund: boolean;
  reason?: string;
  adminId?: string;
}

/**
 * What Payments needs from Commission (module 8), expressed as an interface
 * Payments owns.
 *
 * Named `COMMISSION_REVERSAL_PORT` rather than `COMMISSION_PORT` on purpose.
 * Module 4 already owns a symbol by that name, and a second one would be a
 * distinct symbol with an identical label — legal, working, and impossible to
 * tell apart at an `@Inject` site. This module already carries one `LEDGER_PORT`
 * that module 8 deliberately did not reuse for the same reason.
 *
 * **Only a full refund reverses automatically.** A partial refund is
 * discretionary goodwill — ops handing back ₹100 on a ₹1,000 job the Pro did
 * properly — and clawing back their whole pay for it would be wrong. Module 8
 * logs the partial and leaves the commission alone; ops reverses by hand from
 * the admin route when the Pro genuinely is at fault.
 */
export interface CommissionReversalPort {
  onRefund(notice: RefundReversalNotice): Promise<void>;
}

/**
 * Stand-in until module 8 lands.
 *
 * Quiet, like this module's ledger stub. The refund itself has already
 * succeeded by the time this is called; refusing to complete it because the
 * commission side is absent would leave a customer un-refunded to protect a
 * bookkeeping entry.
 */
@Injectable()
export class NoOpCommissionReversalService implements CommissionReversalPort {
  private readonly logger = new Logger(NoOpCommissionReversalService.name);

  private real: CommissionReversalPort | null = null;

  register(implementation: CommissionReversalPort): void {
    this.real = implementation;
    this.logger.log(
      'Commission reversal registered — refunded jobs now unwind the Pro’s pay.',
    );
  }

  onRefund(notice: RefundReversalNotice): Promise<void> {
    if (this.real) return this.real.onRefund(notice);

    this.logger.warn(
      `Booking ${notice.bookingId} refunded ${notice.amount}, but Commission ` +
        '(module 8) is not built — no commission has been reversed.',
    );
    return Promise.resolve();
  }
}
