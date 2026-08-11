import { Injectable } from '@nestjs/common';
import type {
  ServiceabilityPort,
  ServiceabilityQuery,
} from '../bookings/ports/serviceability.port';
import { LocationService } from './location.service';

/**
 * Satisfies the interface module 4 defined, using the real area map.
 *
 * As thin as `RealDispatchAdapter` and `RealPaymentsAdapter`, and for the same
 * reason: module 4 asks "may this booking happen here, and where is here?",
 * while this module speaks in circles, centres, radii and haversine. None of
 * that vocabulary crosses the port.
 */
@Injectable()
export class RealServiceabilityAdapter implements ServiceabilityPort {
  constructor(private readonly location: LocationService) {}

  resolveForBooking(
    query: ServiceabilityQuery,
  ): Promise<{ areaId: string | null }> {
    return this.location.resolveForBooking(query);
  }
}
