import { Injectable } from '@nestjs/common';
import { haversineKm } from '../dispatch.types';

export const TRAVEL_TIME_PORT = Symbol('TRAVEL_TIME_PORT');

/**
 * What Dispatch needs from Geo & Routing (module 13), as an interface this
 * module owns.
 */
export interface TravelTimePort {
  estimateMinutes(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    assumedSpeedKmph: number,
  ): Promise<number>;
}

/**
 * Straight-line stand-in until module 13 exists.
 *
 * Unlike module 4's payments stub, this one **deliberately returns a usable
 * answer** rather than failing. Crow-flight distance ranks candidates
 * correctly the vast majority of the time at city scale — the ordering between
 * a Pro 3 km away and one 20 km away does not invert once you follow real
 * roads.
 *
 * What it is *not* good enough for is quoting an ETA to a customer, which is
 * why module 4's tracking view still returns a null ETA rather than publishing
 * a number derived from this.
 */
@Injectable()
export class HaversineTravelTimeService implements TravelTimePort {
  estimateMinutes(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    assumedSpeedKmph: number,
  ): Promise<number> {
    const km = haversineKm(fromLat, fromLng, toLat, toLng);
    const speed = assumedSpeedKmph > 0 ? assumedSpeedKmph : 20;
    // Round up: a candidate that is borderline against maxTravelMinutes should
    // fall outside it, not sneak in on a rounding artefact.
    return Promise.resolve(Math.ceil((km / speed) * 60));
  }
}
