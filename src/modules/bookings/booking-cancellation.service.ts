import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Booking } from '../../prisma/client';
import type {
  BookingStatus,
  CancellationWindow,
  CancelledByType,
} from './booking.types';
import {
  cancellationWindowFor,
  windowChargesFee,
  windowRequiresOps,
} from './booking.types';
import { BookingStateService } from './booking-state.service';
import { BookingsService } from './bookings.service';
import { DISPATCH_PORT, type DispatchPort } from './ports/dispatch.port';
import { PAYMENTS_PORT, type PaymentsPort } from './ports/payments.port';
import { PlatformSettingsService } from './platform-settings.service';

interface CancelInput {
  bookingId: string;
  reason: string;
  cancelledByType: CancelledByType;
  actorId: string;
  /** Window E only — a human's number, not a computed one. */
  refundAmount?: string;
  /** Overrides the configured window-D fee. */
  cancellationFeeAmount?: string;
}

/**
 * Cancellation across the six windows.
 *
 * Module 4's responsibility here is deliberately narrow: **own the transition,
 * the reason and the actor, and record what was retained.** Executing the
 * refund belongs to module 7, reversing commission to module 8, and the ledger
 * entries to module 9. What this service must get right is *which window* a
 * booking is in, because that decides everything the other modules then do.
 *
 * Four principles from the scope document shape all of it:
 * nothing is deleted, a Pro can never cancel, salary decouples cancellation
 * from Pro pay, and refunds are asynchronous.
 */
@Injectable()
export class BookingCancellationService {
  constructor(
    private readonly state: BookingStateService,
    private readonly bookings: BookingsService,
    private readonly settings: PlatformSettingsService,
    @Inject(DISPATCH_PORT) private readonly dispatch: DispatchPort,
    @Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort,
  ) {}

  /**
   * The customer's own path. Available any time before the job starts; after
   * that only support can act, because window E is a judgement call.
   */
  async cancelAsCustomer(
    customerId: string,
    bookingId: string,
    reason: string,
  ): Promise<Booking> {
    const booking = await this.bookings.getOwnedBooking(customerId, bookingId);
    const window = this.windowOrFail(booking);

    if (windowRequiresOps(window)) {
      throw apiError(
        'This job has already started. Contact support to stop it — they can arrange a partial refund.',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: 'Cancelling a job in progress needs a support agent',
            code: 'CANCELLATION_NEEDS_SUPPORT',
          },
        ],
      );
    }

    return this.cancel({
      bookingId,
      reason,
      cancelledByType: 'customer',
      actorId: customerId,
    });
  }

  /**
   * Ops. Reaches every window including E, and is the only path that may set a
   * discretionary refund.
   */
  async cancelAsOps(
    adminId: string,
    bookingId: string,
    reason: string,
    refundAmount?: string,
    cancellationFeeAmount?: string,
  ): Promise<Booking> {
    return this.cancel({
      bookingId,
      reason,
      cancelledByType: 'ops',
      actorId: adminId,
      refundAmount,
      cancellationFeeAmount,
    });
  }

  /**
   * The system's own path: a payment hold that expired, a recurring plan that
   * ended, dispatch exhausted with nobody found.
   *
   * **Never charges a fee.** When the platform is the party that failed,
   * charging the customer for it is the one thing US-4.22 rules out flatly.
   */
  async cancelAsSystem(bookingId: string, reason: string): Promise<Booking> {
    return this.cancel({
      bookingId,
      reason,
      cancelledByType: 'system',
      actorId: 'system',
      cancellationFeeAmount: '0',
    });
  }

  /**
   * Cancels online bookings that sat in `awaiting_payment` past the hold
   * window — US-4.6, so an abandoned checkout does not clog the pipeline.
   *
   * Window A, so nothing was ever charged and nothing is refunded. Driven by a
   * scheduled job once module 12 brings a scheduler; exposed as an admin route
   * meanwhile so it can be run and tested.
   *
   * **Known follow-on, unhandled here:** if the customer pays *after* this
   * runs, the gateway webhook arrives for a cancelled booking. US-4.6 says the
   * payment is then recorded and immediately refunded — that is module 7's to
   * implement when the webhook exists, and there is nothing to hook it to yet.
   */
  async expireUnpaidBookings(now = new Date()): Promise<{ cancelled: number }> {
    const holdMinutes = await this.settings.getNumber(
      'booking.paymentHoldWindowMinutes',
      30,
    );
    const cutoff = new Date(now.getTime() - holdMinutes * 60_000);

    const stale = await this.bookings.findAwaitingPaymentBefore(cutoff);

    let cancelled = 0;
    for (const booking of stale) {
      try {
        await this.cancelAsSystem(
          booking.id,
          `Payment not completed within ${holdMinutes} minutes`,
        );
        cancelled += 1;
      } catch {
        // A booking that moved on between the query and the cancel is not an
        // error — the sweep is best-effort and runs again shortly.
      }
    }

    return { cancelled };
  }

  /** Which of the six windows a booking is in, for display and for ops. */
  async describeWindow(bookingId: string): Promise<{
    window: CancellationWindow | null;
    chargesFee: boolean;
    requiresOps: boolean;
    feeAmount: string;
  }> {
    const booking = await this.bookings.getByIdOrFail(bookingId);
    const window = cancellationWindowFor(booking.status as BookingStatus);
    const fee = await this.configuredFee();

    return {
      window,
      chargesFee: window ? windowChargesFee(window) : false,
      requiresOps: window ? windowRequiresOps(window) : false,
      feeAmount: window && windowChargesFee(window) ? fee : '0',
    };
  }

  // ------------------------------------------------------------------

  private async cancel(input: CancelInput): Promise<Booking> {
    const booking = await this.bookings.getByIdOrFail(input.bookingId);
    const window = this.windowOrFail(booking);

    const fee = await this.resolveFee(window, input);
    const refund = this.resolveRefund(booking, window, input, fee);

    // Release the Pro before anything else. Window D exists because someone is
    // physically driving to this address — every second of delay is a wasted
    // journey (US-4.20).
    if (['C', 'D', 'E'].includes(window)) {
      await this.dispatch.closeAssignment(booking.id, input.reason);
    }

    const cancelled = await this.state.transition({
      bookingId: booking.id,
      to: 'cancelled',
      actorType: input.cancelledByType,
      actorId: input.actorId,
      expectedFrom: BookingsService.liveStatuses,
      data: {
        cancelledAt: new Date(),
        cancelReason: input.reason,
        cancelledByType: input.cancelledByType,
        cancellationFeeAmount: fee,
        refundedAmount: refund,
        // Nothing is deleted or edited: the assignment columns keep whatever
        // they held, and the status event records what happened to them.
        assignmentOutcome: booking.proId
          ? 'cancelled'
          : booking.assignmentOutcome,
      },
    });

    // Windows A and B never charged anything, so there is nothing to send.
    if (refund !== '0' && booking.paymentStatus === 'paid') {
      await this.payments.initiateRefund(booking.id, refund);
    }

    return cancelled;
  }

  private windowOrFail(booking: Booking): CancellationWindow {
    const window = cancellationWindowFor(booking.status as BookingStatus);

    if (window === null) {
      throw apiError('This booking is already cancelled', HttpStatus.CONFLICT);
    }
    // Window F is not a cancellation at all. A completed job is disputed,
    // which is a different path with a different evidence bar (module 11).
    if (window === 'F') {
      throw apiError(
        'This job is already complete. Raise a dispute through support instead.',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: 'A completed job cannot be cancelled',
            code: 'BOOKING_ALREADY_COMPLETED',
          },
        ],
      );
    }

    return window;
  }

  /** Only window D carries one, and only when the customer is the canceller. */
  private async resolveFee(
    window: CancellationWindow,
    input: CancelInput,
  ): Promise<string> {
    if (input.cancellationFeeAmount !== undefined) {
      return input.cancellationFeeAmount;
    }
    if (!windowChargesFee(window)) return '0';
    // The platform failing to supply is never the customer's cost.
    if (input.cancelledByType !== 'customer') return '0';
    return this.configuredFee();
  }

  private resolveRefund(
    booking: Booking,
    window: CancellationWindow,
    input: CancelInput,
    fee: string,
  ): string {
    // Nothing was ever charged in window A.
    if (window === 'A' || booking.paymentStatus !== 'paid') return '0';

    if (window === 'E') {
      // Deliberately not computed. "Partial, at ops discretion" — routing this
      // to a formula is exactly what US-4.21 warns against.
      return input.refundAmount ?? '0';
    }

    const paid = Number(booking.flatPrice);
    const refund = Math.max(0, paid - Number(fee));
    return refund.toFixed(2);
  }

  private configuredFee(): Promise<string> {
    return this.settings
      .getNumber('booking.cancellationFeeAmount', 0)
      .then((value) => value.toFixed(2));
  }
}
