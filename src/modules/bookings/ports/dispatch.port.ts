import { Injectable, Logger } from '@nestjs/common';

export const DISPATCH_PORT = Symbol('DISPATCH_PORT');

export interface AvailableSlot {
  slotStartAt: Date;
  slotEndAt: Date;
}

/**
 * What Booking needs from Dispatch (module 5), expressed as an interface
 * Booking owns.
 *
 * Module 5 does not exist. Rather than block the whole module on it, this port
 * is defined here and satisfied by {@link NoOpDispatchService} — so every code
 * path around assignment is written, wired and tested now, and module 5 later
 * provides a real implementation without a single change inside module 4.
 */
export interface DispatchPort {
  /** Hand a booking to the engine. Assignment happens asynchronously. */
  requestAssignment(bookingId: string): Promise<void>;

  /**
   * Release the Pro and cancel queued retries. Called on every cancellation
   * from window C onward — otherwise a Pro keeps driving to a job that no
   * longer exists (US-4.20).
   */
  closeAssignment(bookingId: string, reason: string): Promise<void>;

  /** Free windows from the live roster and committed jobs. */
  getAvailableSlots(
    serviceId: string,
    addressId: string,
    date: Date,
  ): Promise<AvailableSlot[]>;
}

/**
 * Stand-in until module 5 lands.
 *
 * It deliberately does **not** fake an assignment. A booking handed to it stays
 * in `assigning` until an ops admin assigns it by hand via
 * `POST /admin/bookings/:id/assign`, which is honest: the product genuinely has
 * no automatic dispatch yet, and pretending otherwise would hide it.
 *
 * `getAvailableSlots` returns `[]` for the same reason — no free-window
 * computation exists, and inventing plausible-looking slots would sell times
 * nobody can work.
 */
@Injectable()
export class NoOpDispatchService implements DispatchPort {
  private readonly logger = new Logger(NoOpDispatchService.name);

  /**
   * The real engine, registered at boot by module 5 if it is present.
   *
   * This indirection is what lets module 4 depend on nothing but its own
   * interface. Binding `DISPATCH_PORT` directly in `DispatchModule` would not
   * work — Nest resolves providers per module, so `BookingsService` would keep
   * getting *this* class no matter what module 5 declared. The alternative,
   * making `BookingsModule` import `DispatchModule`, would invert the
   * dependency the port exists to prevent.
   */
  private real: DispatchPort | null = null;

  register(implementation: DispatchPort): void {
    this.real = implementation;
    this.logger.log(
      'Dispatch engine registered — assignments are now automatic.',
    );
  }

  get isEngineRegistered(): boolean {
    return this.real !== null;
  }

  requestAssignment(bookingId: string): Promise<void> {
    if (this.real) return this.real.requestAssignment(bookingId);
    this.logger.log(
      `Booking ${bookingId} is awaiting assignment. No dispatch engine is registered — an admin must assign it manually.`,
    );
    return Promise.resolve();
  }

  closeAssignment(bookingId: string, reason: string): Promise<void> {
    if (this.real) return this.real.closeAssignment(bookingId, reason);
    this.logger.log(`Assignment closed for booking ${bookingId}: ${reason}`);
    return Promise.resolve();
  }

  getAvailableSlots(
    serviceId: string,
    addressId: string,
    date: Date,
  ): Promise<AvailableSlot[]> {
    if (this.real) {
      return this.real.getAvailableSlots(serviceId, addressId, date);
    }
    this.logger.warn(
      'Slot availability requested, but no dispatch engine is registered — returning none rather than inventing slots.',
    );
    return Promise.resolve([]);
  }
}
