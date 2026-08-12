export const ROUTER = Symbol('ROUTER');

export interface TravelEstimate {
  /** Road minutes, rounded up. Never negative, never zero for a real journey. */
  minutes: number;
  /** Road distance in metres, when the provider gives one. */
  distanceMetres: number | null;
  /**
   * `google` — a real road route, traffic-aware.
   * `haversine` — a straight line over an assumed speed.
   *
   * Carried all the way to the caller on purpose. An ETA a customer is shown
   * and an ETA used to rank candidates have very different accuracy
   * requirements, and the only way a caller can apply that judgement is to
   * know which it received.
   */
  source: 'google' | 'haversine';
}

export interface RoutingPort {
  /**
   * One origin to one destination.
   *
   * `assumedSpeedKmph` is only consulted by the straight-line implementation.
   * It stays on the signature so a caller does not have to know which
   * implementation answered in order to call it.
   */
  estimate(input: {
    fromLat: number;
    fromLng: number;
    toLat: number;
    toLng: number;
    assumedSpeedKmph: number;
  }): Promise<TravelEstimate>;

  /**
   * Many origins to one destination, in one call.
   *
   * Dispatch scores every candidate Pro against a single job. Asking that as N
   * separate requests is N times the latency and N times the bill for the
   * same answer, so the matrix form exists and dispatch uses it.
   *
   * Returns results **positionally** — `result[i]` belongs to `origins[i]` —
   * because a provider that drops or reorders rows would otherwise silently
   * assign one Pro's travel time to another.
   */
  estimateMany(input: {
    origins: { lat: number; lng: number }[];
    toLat: number;
    toLng: number;
    assumedSpeedKmph: number;
  }): Promise<TravelEstimate[]>;

  /** `google` or `haversine`. For logging and for the health surface. */
  readonly name: 'google' | 'haversine';
}
