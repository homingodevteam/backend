import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { RedisService } from '../../redis/redis.service';
import { ProsService } from '../pros/pros.service';
import { BookingsService } from './bookings.service';
import type { BookingStatus } from './booking.types';

/** The GEO index module 6's location ingest writes to. */
const PRO_LIVE_GEO_KEY = 'pros:live';

/**
 * Statuses where a customer is actually waiting for someone to arrive. Outside
 * these, tracking is meaningless and showing a pin would be misleading.
 */
const TRACKABLE_STATUSES: BookingStatus[] = ['assigned', 'en_route', 'arrived'];

export interface TrackingView {
  status: string;
  proId: string | null;
  position: { lat: number; lng: number } | null;
  /** True when the Pro's phone has stopped reporting. */
  isStale: boolean;
  lastReportedAt: Date | null;
  /** Always null for now — ETA computation is module 13's. */
  etaMinutes: number | null;
}

/**
 * The customer's "where are they?" view.
 *
 * Position is read from Redis and **never written to the booking** — live
 * state does not belong in a table. What this service adds beyond a raw
 * lookup is staleness: US-4.7 is explicit that a frozen pin reads as "they've
 * parked", not "we lost them", so a Pro whose phone has gone quiet must be
 * reported as stale rather than shown at their last known spot as if it were
 * current.
 */
@Injectable()
export class BookingTrackingService {
  /** Beyond this, a position is last-known rather than live. */
  private static readonly STALE_AFTER_MS = 3 * 60_000;

  constructor(
    private readonly bookings: BookingsService,
    private readonly redis: RedisService,
    // The cold-flush fallback lives on the Pro record, which module 6 owns.
    private readonly pros: ProsService,
  ) {}

  async getTracking(
    customerId: string,
    bookingId: string,
  ): Promise<TrackingView> {
    const booking = await this.bookings.getOwnedBooking(customerId, bookingId);

    if (!TRACKABLE_STATUSES.includes(booking.status as BookingStatus)) {
      throw apiError(
        'There is nobody on the way to this booking yet',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: `Tracking is available while a booking is ${TRACKABLE_STATUSES.join(', ')}`,
            code: 'BOOKING_NOT_TRACKABLE',
          },
        ],
      );
    }

    const base = {
      status: booking.status,
      proId: booking.proId,
      etaMinutes: null,
    };

    if (!booking.proId) {
      return { ...base, position: null, isStale: true, lastReportedAt: null };
    }

    const live = await this.redis.geoPosition(PRO_LIVE_GEO_KEY, booking.proId);
    if (live) {
      return {
        ...base,
        position: { lat: live.latitude, lng: live.longitude },
        isStale: false,
        lastReportedAt: null,
      };
    }

    // Nothing live. Fall back to the cold flush module 6 writes onto the Pro
    // record, and label it honestly rather than passing it off as current.
    const pro = await this.pros.getById(booking.proId);
    if (!pro.lastKnownLat || !pro.lastKnownLng) {
      return { ...base, position: null, isStale: true, lastReportedAt: null };
    }

    const age = pro.lastLocationAt
      ? Date.now() - pro.lastLocationAt.getTime()
      : Number.POSITIVE_INFINITY;

    return {
      ...base,
      position: { lat: pro.lastKnownLat, lng: pro.lastKnownLng },
      isStale: age > BookingTrackingService.STALE_AFTER_MS,
      lastReportedAt: pro.lastLocationAt ?? null,
    };
  }
}
