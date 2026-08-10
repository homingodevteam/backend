import { Injectable, Logger } from '@nestjs/common';
import type {
  AvailableSlot,
  DispatchPort,
} from '../bookings/ports/dispatch.port';
import { DispatchService } from './dispatch.service';

/**
 * Satisfies the interface module 4 defined, using the real engine.
 *
 * Its only job is translation: module 4 speaks in "request an assignment",
 * this module speaks in queues, locks and attempts. Keeping the adapter thin
 * means module 4 never learns either vocabulary.
 */
@Injectable()
export class RealDispatchAdapter implements DispatchPort {
  private readonly logger = new Logger(RealDispatchAdapter.name);

  constructor(private readonly dispatch: DispatchService) {}

  /**
   * Enqueue rather than dispatch inline. Booking creation must not block on
   * scoring every Pro in the city, and an instant booking that took two
   * seconds to return would be a worse product than one assigned a moment
   * later.
   */
  async requestAssignment(bookingId: string): Promise<void> {
    await this.dispatch.enqueue(bookingId);
  }

  /**
   * Cancellation, ops override or a no-ack timeout. The candidate rows stay —
   * nothing is deleted, and they are the only record that this attempt ever
   * happened.
   */
  closeAssignment(bookingId: string, reason: string): Promise<void> {
    this.logger.log(`Assignment closed for booking ${bookingId}: ${reason}`);
    return Promise.resolve();
  }

  /**
   * Still empty, and deliberately.
   *
   * Offering slots means promising a Pro will be free then, and free-window
   * computation answers that for *one* Pro against *one* proposed slot — not
   * "what times are open across the city today", which is a different and
   * more expensive query. Returning plausible-looking slots would sell times
   * nobody can work, which is exactly what US-4.2 warns about.
   */
  getAvailableSlots(): Promise<AvailableSlot[]> {
    return Promise.resolve([]);
  }
}
