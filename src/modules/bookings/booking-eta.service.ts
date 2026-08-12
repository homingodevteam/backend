import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ROUTER, type RoutingPort } from '../../routing/routing.types';

/**
 * "How long until they get here?"
 *
 * ## The rule that shapes this whole class
 *
 * **A straight-line guess is never published as an arrival time.**
 *
 * The router always answers — it degrades to crow-flight when Google is
 * absent or unreachable — and that answer is right for *ranking* candidates,
 * where only the ordering matters. It is wrong for a customer, who reads "8
 * minutes" as a promise and plans around it. Indore's road network is not a
 * straight line; the same 4 km is eight minutes at 6 a.m. and twenty-five at
 * 6 p.m.
 *
 * So this returns `null` for anything that is not a real road estimate, and
 * the app shows "on the way" instead of a number. A missing ETA is a small
 * disappointment. A confidently wrong one is a customer standing at the door.
 *
 * ## Cost
 *
 * A Pro's phone reports every few seconds and every report fans out to every
 * booking they are travelling to. Left alone that is thousands of billed calls
 * an hour per job. Two things stop it: the router caches by rounded origin, so
 * a Pro who has moved less than ~110 m reuses the last answer, and the cache
 * expires in 60 seconds, so a genuinely moving Pro costs about one call a
 * minute per job.
 */
@Injectable()
export class BookingEtaService {
  private readonly logger = new Logger(BookingEtaService.name);

  /**
   * Only ever reaches the straight-line path, whose answer this class
   * discards. It exists because the port takes it, not because it is used.
   */
  private static readonly NOMINAL_SPEED_KMPH = 20;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ROUTER) private readonly router: RoutingPort,
  ) {}

  /**
   * Minutes until the Pro reaches the booking's address, or `null`.
   *
   * `null` means "we do not have a number worth showing" — no live position,
   * no road route, or no key configured. It never means zero.
   */
  async forBooking(
    bookingId: string,
    position: { lat: number; lng: number } | null,
  ): Promise<number | null> {
    if (!position) return null;

    const destination = await this.destinationOf(bookingId);
    if (!destination) return null;

    return this.between(position, destination);
  }

  /**
   * The same question when the caller already knows the destination.
   *
   * The broadcaster fans one GPS ping out to several bookings and already
   * joins the address to do it, so making it re-read the pin per booking would
   * be a query per frame for data it is holding.
   */
  async between(
    position: { lat: number; lng: number },
    destination: { lat: number; lng: number },
  ): Promise<number | null> {
    try {
      const estimate = await this.router.estimate({
        fromLat: position.lat,
        fromLng: position.lng,
        toLat: destination.lat,
        toLng: destination.lng,
        assumedSpeedKmph: BookingEtaService.NOMINAL_SPEED_KMPH,
      });

      // The whole point. See the class comment.
      if (estimate.source !== 'google') return null;

      return estimate.minutes;
    } catch (error) {
      // The router is already meant to be total, so reaching here is a bug in
      // it rather than an outage. Either way an ETA is not worth failing a
      // tracking read for.
      this.logger.warn(
        `Could not estimate an ETA: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
  }

  /** The booking's address pin. Null if the booking or its address is gone. */
  private async destinationOf(
    bookingId: string,
  ): Promise<{ lat: number; lng: number } | null> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { address: { select: { pinLat: true, pinLng: true } } },
    });
    if (!booking?.address) return null;

    return { lat: booking.address.pinLat, lng: booking.address.pinLng };
  }
}
