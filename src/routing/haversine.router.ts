import { Injectable } from '@nestjs/common';
import type { RoutingPort, TravelEstimate } from './routing.types';

/** Mean Earth radius in kilometres. */
const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two pins.
 *
 * Duplicated from `dispatch.types` deliberately: this package sits below
 * `modules/` and must not import from it, and the alternative — a shared
 * `common/geo.ts` — would move a function module 5 owns out from under it for
 * the sake of eleven lines. If a third caller ever appears, that is the moment
 * to promote it.
 */
export function haversineKm(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(toLat - fromLat);
  const dLng = toRad(toLng - fromLng);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The free path, and the safety net under the paid one.
 *
 * A straight line over an assumed speed. That is good enough to **rank**
 * candidates — the ordering between a Pro 3 km away and one 20 km away does
 * not invert once you follow real roads — and it is not good enough to
 * **quote** an arrival time to a customer, which is why every estimate carries
 * `source` and the customer-facing path checks it.
 *
 * This is also what answers when Google is unreachable. An ETA is a
 * convenience; live tracking is not, and taking the map down because a routing
 * call timed out would trade something that matters for something that does
 * not.
 */
@Injectable()
export class HaversineRouter implements RoutingPort {
  readonly name = 'haversine' as const;

  estimate(input: {
    fromLat: number;
    fromLng: number;
    toLat: number;
    toLng: number;
    assumedSpeedKmph: number;
  }): Promise<TravelEstimate> {
    return Promise.resolve(this.compute(input));
  }

  estimateMany(input: {
    origins: { lat: number; lng: number }[];
    toLat: number;
    toLng: number;
    assumedSpeedKmph: number;
  }): Promise<TravelEstimate[]> {
    return Promise.resolve(
      input.origins.map((origin) =>
        this.compute({
          fromLat: origin.lat,
          fromLng: origin.lng,
          toLat: input.toLat,
          toLng: input.toLng,
          assumedSpeedKmph: input.assumedSpeedKmph,
        }),
      ),
    );
  }

  private compute(input: {
    fromLat: number;
    fromLng: number;
    toLat: number;
    toLng: number;
    assumedSpeedKmph: number;
  }): TravelEstimate {
    const km = haversineKm(
      input.fromLat,
      input.fromLng,
      input.toLat,
      input.toLng,
    );
    // A zero or negative speed would divide to Infinity and rank every
    // candidate identically — worse than a wrong-but-ordered answer.
    const speed = input.assumedSpeedKmph > 0 ? input.assumedSpeedKmph : 20;

    return {
      // Rounded up, so a candidate sitting exactly on a threshold falls
      // outside it rather than sneaking in on a rounding artefact.
      minutes: Math.max(1, Math.ceil((km / speed) * 60)),
      // Deliberately null rather than the straight-line distance. This is not
      // a road distance, and a caller that displayed it as one would be
      // understating every journey.
      distanceMetres: null,
      source: 'haversine',
    };
  }
}
