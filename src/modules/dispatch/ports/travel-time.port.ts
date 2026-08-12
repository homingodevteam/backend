import { Inject, Injectable } from '@nestjs/common';
import { ROUTER, type RoutingPort } from '../../../routing/routing.types';

export const TRAVEL_TIME_PORT = Symbol('TRAVEL_TIME_PORT');

/**
 * What Dispatch needs from routing, as an interface this module owns.
 */
export interface TravelTimePort {
  estimateMinutes(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    assumedSpeedKmph: number,
  ): Promise<number>;

  /**
   * Every candidate against one job, in one call.
   *
   * Dispatch's question is inherently a matrix, and asking it N times costs N
   * times the latency and N times the money for the same answer. Results are
   * **positional** — `result[i]` belongs to `origins[i]`.
   */
  estimateManyMinutes(
    origins: { lat: number; lng: number }[],
    toLat: number,
    toLng: number,
    assumedSpeedKmph: number,
  ): Promise<number[]>;
}

/**
 * Dispatch's adapter onto the shared router.
 *
 * This used to be `HaversineTravelTimeService`, a straight-line stand-in with
 * a comment saying module 13 would replace it. It is now a thin translation
 * onto `ROUTER`, which is Google Routes when a key is present and the same
 * straight-line maths when it is not — so the stand-in's behaviour survives
 * exactly, as the fallback rather than as the only option.
 *
 * Dispatch deliberately throws away `source` and `distanceMetres`. A ranking
 * only needs the ordering to be right, and crow-flight preserves it at city
 * scale; it is the customer-facing ETA that cares which kind of answer it got.
 */
@Injectable()
export class RoutedTravelTimeService implements TravelTimePort {
  constructor(@Inject(ROUTER) private readonly router: RoutingPort) {}

  async estimateMinutes(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    assumedSpeedKmph: number,
  ): Promise<number> {
    const estimate = await this.router.estimate({
      fromLat,
      fromLng,
      toLat,
      toLng,
      assumedSpeedKmph,
    });
    return estimate.minutes;
  }

  async estimateManyMinutes(
    origins: { lat: number; lng: number }[],
    toLat: number,
    toLng: number,
    assumedSpeedKmph: number,
  ): Promise<number[]> {
    const estimates = await this.router.estimateMany({
      origins,
      toLat,
      toLng,
      assumedSpeedKmph,
    });
    return estimates.map((estimate) => estimate.minutes);
  }
}
