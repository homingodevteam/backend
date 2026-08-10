import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../../common/utils';

export const PAYMENTS_PORT = Symbol('PAYMENTS_PORT');

export interface CreatedOrder {
  orderId: string;
}

/**
 * What Booking needs from Payments (module 7), expressed as an interface
 * Booking owns.
 *
 * Module 7 does not exist. Because a **cash** booking has no `Order` row at
 * all and skips `awaiting_payment` entirely, the entire cash path runs today
 * without this port being implemented — which is what makes a real end-to-end
 * job demonstrable now.
 */
export interface PaymentsPort {
  /**
   * Server-side order creation. Must happen before checkout opens, or the
   * amount could be tampered with client-side (US-7.1).
   */
  createOrder(bookingId: string, amount: string): Promise<CreatedOrder>;

  /**
   * Begin a refund. Asynchronous by nature — Razorpay initiates immediately
   * but settles in roughly 5–7 working days, and "initiated" and "settled"
   * are different states the customer must be able to tell apart.
   */
  initiateRefund(bookingId: string, amount: string): Promise<void>;
}

/**
 * Stand-in until module 7 lands.
 *
 * `createOrder` **fails loudly** rather than returning a fake order id. An
 * online booking that appeared to have an order but did not would sit in
 * `awaiting_payment` forever with no way to diagnose why; a `501` at creation
 * says exactly what is missing.
 *
 * `initiateRefund` logs the intent and returns. Module 4's own responsibility
 * in the refund flow is narrow — own the transition, the reason and the actor,
 * and record what was retained. Executing the refund, writing the ledger entry
 * and reversing commission belong to modules 7, 9 and 8.
 */
@Injectable()
export class NoOpPaymentsService implements PaymentsPort {
  private readonly logger = new Logger(NoOpPaymentsService.name);

  createOrder(bookingId: string): Promise<CreatedOrder> {
    throw apiError(
      'Online payment is not available yet — book with cash on delivery instead',
      HttpStatus.NOT_IMPLEMENTED,
      [
        {
          field: 'paymentMode',
          message: `Payments (module 7) is not built, so no order can be created for booking ${bookingId}`,
          code: 'PAYMENTS_NOT_AVAILABLE',
        },
      ],
    );
  }

  initiateRefund(bookingId: string, amount: string): Promise<void> {
    this.logger.warn(
      `Refund of ${amount} recorded against booking ${bookingId}, but Payments (module 7) is not built — nothing has been sent to the gateway.`,
    );
    return Promise.resolve();
  }
}
