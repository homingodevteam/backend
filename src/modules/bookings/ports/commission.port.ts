import { Injectable, Logger } from '@nestjs/common';

export const COMMISSION_PORT = Symbol('COMMISSION_PORT');

/**
 * What Booking needs from Commission (module 8), expressed as an interface
 * Booking owns.
 *
 * One method, called the moment a job completes. Feature 3 of module 8 says
 * "per-booking commission computed the moment the job completes", and US-8.5
 * says the Pro's live earnings update immediately — so this sits beside the
 * existing `ProCountersService.recordCompletion` call in
 * `booking-lifecycle.service.ts` and copies its **non-fatal** shape.
 */
export interface CommissionPort {
  /**
   * Compute and store what this job earned the Pro.
   *
   * **Must be idempotent.** The call site retries nothing, but a sweeper on
   * the other side re-runs anything that failed, and `BookingCommission` is
   * unique per booking — so a second call on the same job is expected and
   * must be a no-op rather than a second payment.
   */
  recordCompletion(bookingId: string, proId: string): Promise<void>;
}

/**
 * Stand-in until module 8 lands, and the delegate it registers into.
 *
 * Fails **quietly**, like module 7's ledger stub and unlike module 4's
 * payments stub. The distinction is what the failure costs: a booking with a
 * phantom order is unrecoverable, so `createOrder` throws; a completed job
 * with no commission row is recoverable, because the booking, its price and
 * the service's rate are all still there to compute from.
 *
 * What it must never do is take the completion down with it. A Pro standing in
 * a customer's kitchen whose "finish job" button fails will tap it again, and
 * then call support — over a row that a background sweep would have written a
 * minute later.
 */
@Injectable()
export class NoOpCommissionService implements CommissionPort {
  private readonly logger = new Logger(NoOpCommissionService.name);

  /**
   * The real calculator, registered at boot by module 8 if it is present.
   *
   * The same indirection `NoOpPaymentsService` uses, for the same reason: Nest
   * resolves providers per module, so re-binding `COMMISSION_PORT` inside
   * `CommissionModule` would never reach `BookingLifecycleService`.
   */
  private real: CommissionPort | null = null;

  register(implementation: CommissionPort): void {
    this.real = implementation;
    this.logger.log(
      'Commission calculator registered — completed jobs now earn a Pro their pay.',
    );
  }

  get isRegistered(): boolean {
    return this.real !== null;
  }

  recordCompletion(bookingId: string, proId: string): Promise<void> {
    if (this.real) return this.real.recordCompletion(bookingId, proId);

    this.logger.warn(
      `Booking ${bookingId} completed by Pro ${proId}, but Commission (module 8) ` +
        'is not built — no pay has been recorded for this job.',
    );
    return Promise.resolve();
  }
}
