import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type {
  CreatedOrder,
  PaymentsPort,
} from '../bookings/ports/payments.port';
import { CashEligibilityService } from './cash-eligibility.service';
import { OrdersService } from './orders.service';
import { RefundsService } from './refunds.service';

/**
 * Satisfies the interface module 4 defined, using the real gateway.
 *
 * Thin on purpose, like `RealDispatchAdapter`: module 4 speaks in "create an
 * order for this booking", this module speaks in receipts, paise, notes and
 * gateway customers. Keeping the translation here means module 4 never learns
 * any of that vocabulary — and it is why swapping the gateway later touches
 * nothing outside this folder.
 */
@Injectable()
export class RealPaymentsAdapter implements PaymentsPort {
  private readonly logger = new Logger(RealPaymentsAdapter.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
    private readonly cash: CashEligibilityService,
  ) {}

  /**
   * Feature 11's two gates, asked at booking creation.
   *
   * The reason reaches the customer verbatim, so both messages are written for
   * them rather than for us — "this service must be paid for online" is
   * actionable; "CASH_DISABLED_FOR_SERVICE" is not.
   */
  async assertCashAllowed(
    serviceId: string,
    cityId: string | null,
  ): Promise<void> {
    const decision = await this.cash.canOfferCash({ serviceId, cityId });
    if (decision.allowed) return;

    throw apiError(decision.reason!, HttpStatus.CONFLICT, [
      {
        field: 'paymentMode',
        message: 'Cash is not available for this booking',
        code: decision.code!,
      },
    ]);
  }

  /**
   * Module 4 calls this during booking creation, when the booking has just
   * entered `awaiting_payment`.
   *
   * It returns the gateway order id — the customer app still has to call
   * `POST /bookings/:id/payment/order` to get the full checkout handoff (key
   * id, amount, prefill). That is not duplication: booking creation must not
   * hand out a publishable key to a caller who may never open checkout, and
   * the app needs a route it can retry when the customer returns to a booking
   * they abandoned.
   */
  async createOrder(bookingId: string, amount: string): Promise<CreatedOrder> {
    const booking = await this.orders.customerIdFor(bookingId);
    const handoff = await this.orders.createForBooking(bookingId, booking);

    this.logger.log(
      `Order ${handoff.razorpayOrderId} created for booking ${bookingId} (${amount})`,
    );

    return { orderId: handoff.razorpayOrderId };
  }

  /**
   * Module 4's cancellation flow calls this once it has decided what is owed.
   * The refund window — initiated now, settled in 5–7 working days — belongs
   * entirely to this side of the port.
   */
  async initiateRefund(bookingId: string, amount: string): Promise<void> {
    await this.refunds.initiate({
      bookingId,
      amount,
      reason: 'booking_cancelled',
    });
  }
}
