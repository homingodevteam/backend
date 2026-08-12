import { Injectable, Logger } from '@nestjs/common';
import type { GoogleRoutesOptions } from '../config/routing.config';
import { RedisService } from '../redis/redis.service';
import { HaversineRouter } from './haversine.router';
import type { RoutingPort, TravelEstimate } from './routing.types';

interface RouteMatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  /** Protobuf duration, e.g. `"1263s"`. */
  duration?: string;
  distanceMeters?: number;
  /** `ROUTE_EXISTS` | `ROUTE_NOT_FOUND`. */
  condition?: string;
  status?: { code?: number; message?: string };
}

/**
 * Google's **Routes API** — real road time, traffic-aware.
 *
 * Targets `computeRouteMatrix` for both the one-to-one and many-to-one cases,
 * because dispatch's question is inherently a matrix: score twenty candidates
 * against one job. Asking that twenty times costs twenty times the latency and
 * twenty times the money for the same answer.
 *
 * Not the legacy Distance Matrix API. Google marked that legacy in 2025 and
 * projects created since cannot enable it, so a build against it would work on
 * old keys and fail on new ones — see `routing.config.ts`.
 *
 * ## Two properties this class exists to guarantee
 *
 * **Results are positional.** The API returns elements carrying
 * `originIndex`, in no guaranteed order, and may omit one entirely. Reading
 * them in arrival order would assign one Pro's travel time to another — a
 * silent, plausible, completely wrong dispatch ranking. Everything is placed
 * by index, and a missing index falls back rather than shifting its neighbours.
 *
 * **It never fails the caller.** Every path degrades to a straight-line
 * estimate. An ETA is a convenience; the live map and the dispatch decision
 * behind it are not, and taking those down because a routing call timed out
 * would trade something that matters for something that does not.
 */
@Injectable()
export class GoogleRouter implements RoutingPort {
  private readonly logger = new Logger(GoogleRouter.name);
  readonly name = 'google' as const;

  /**
   * Google bills per element. A matrix is origins × destinations, and this is
   * always one destination, so this bounds a single dispatch pass. Anything
   * beyond it falls back rather than quietly costing a fortune.
   */
  private static readonly MAX_ORIGINS = 50;

  constructor(
    private readonly options: GoogleRoutesOptions,
    private readonly redis: RedisService,
    /** The safety net. Same class the free deployment uses. */
    private readonly fallback: HaversineRouter,
  ) {}

  async estimate(input: {
    fromLat: number;
    fromLng: number;
    toLat: number;
    toLng: number;
    assumedSpeedKmph: number;
  }): Promise<TravelEstimate> {
    const [only] = await this.estimateMany({
      origins: [{ lat: input.fromLat, lng: input.fromLng }],
      toLat: input.toLat,
      toLng: input.toLng,
      assumedSpeedKmph: input.assumedSpeedKmph,
    });
    return only;
  }

  async estimateMany(input: {
    origins: { lat: number; lng: number }[];
    toLat: number;
    toLng: number;
    assumedSpeedKmph: number;
  }): Promise<TravelEstimate[]> {
    if (input.origins.length === 0) return [];

    const fallbacks = await this.fallback.estimateMany(input);

    if (input.origins.length > GoogleRouter.MAX_ORIGINS) {
      this.logger.warn(
        `Asked to route ${input.origins.length} origins, over the ${GoogleRouter.MAX_ORIGINS} cap. ` +
          'Falling back to straight lines for this pass rather than billing a matrix that size.',
      );
      return fallbacks;
    }

    // Cache per origin, not per request: a dispatch pass and a live-tracking
    // ping ask about overlapping origins constantly, and a whole-request key
    // would miss every time one candidate changed.
    const keys = input.origins.map((origin) =>
      this.cacheKey(origin, input.toLat, input.toLng),
    );
    const cached = await Promise.all(keys.map((key) => this.readCache(key)));

    const misses = cached
      .map((hit, index) => (hit ? -1 : index))
      .filter((index) => index >= 0);

    if (misses.length === 0) {
      return cached.map((hit, index) => hit ?? fallbacks[index]);
    }

    let fresh: (TravelEstimate | null)[];
    try {
      fresh = await this.fetchMatrix(
        misses.map((index) => input.origins[index]),
        input.toLat,
        input.toLng,
      );
    } catch (error) {
      this.logger.warn(
        `Routes API unavailable, using straight-line estimates: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return cached.map((hit, index) => hit ?? fallbacks[index]);
    }

    const results = [...cached];
    await Promise.all(
      misses.map(async (originIndex, position) => {
        const estimate = fresh[position];
        if (!estimate) return;
        results[originIndex] = estimate;
        await this.writeCache(keys[originIndex], estimate);
      }),
    );

    // A Pro Google could not route to still needs a number, or they drop out
    // of the ranking entirely for living somewhere the road graph is thin.
    return results.map((hit, index) => hit ?? fallbacks[index]);
  }

  /**
   * One `computeRouteMatrix` call.
   *
   * The field mask is mandatory and is also the bill: asking for
   * `routes.polyline` here would multiply the cost for data nothing renders.
   */
  private async fetchMatrix(
    origins: { lat: number; lng: number }[],
    toLat: number,
    toLng: number,
  ): Promise<(TravelEstimate | null)[]> {
    const url = `${this.options.baseUrl}/distanceMatrix/v2:computeRouteMatrix`;

    const body = {
      origins: origins.map((origin) => ({
        waypoint: {
          location: { latLng: { latitude: origin.lat, longitude: origin.lng } },
        },
      })),
      destinations: [
        {
          waypoint: {
            location: { latLng: { latitude: toLat, longitude: toLng } },
          },
        },
      ],
      travelMode: 'DRIVE',
      // TRAFFIC_AWARE, not TRAFFIC_AWARE_OPTIMAL. The optimal mode costs
      // materially more per element for an accuracy difference that does not
      // survive being rounded to whole minutes on a customer's screen.
      routingPreference: 'TRAFFIC_AWARE',
      ...(this.options.region ? { regionCode: this.options.region } : {}),
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.options.apiKey,
          'X-Goog-FieldMask':
            'originIndex,destinationIndex,duration,distanceMeters,condition',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw new Error(
        `could not reach the Routes API: ${cause instanceof Error ? cause.message : 'unknown'}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Routes API returned ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    let elements: RouteMatrixElement[];
    try {
      const parsed: unknown = JSON.parse(text);
      // computeRouteMatrix answers with a bare JSON array.
      elements = Array.isArray(parsed) ? (parsed as RouteMatrixElement[]) : [];
    } catch {
      throw new Error('Routes API returned a body that is not JSON');
    }

    // Placed by `originIndex`, never by arrival order. See the class comment:
    // reading these positionally is how one Pro gets another's travel time.
    const byOrigin: (TravelEstimate | null)[] = origins.map(() => null);

    for (const element of elements) {
      const index = element.originIndex;
      if (index === undefined || index < 0 || index >= origins.length) continue;
      if (element.condition && element.condition !== 'ROUTE_EXISTS') continue;

      const seconds = this.parseDuration(element.duration);
      if (seconds === null) continue;

      byOrigin[index] = {
        minutes: Math.max(1, Math.ceil(seconds / 60)),
        distanceMetres: element.distanceMeters ?? null,
        source: 'google',
      };
    }

    return byOrigin;
  }

  /** `"1263s"` → `1263`. Anything else is not a duration we can use. */
  private parseDuration(duration: string | undefined): number | null {
    if (!duration) return null;
    const match = /^(\d+(?:\.\d+)?)s$/.exec(duration);
    if (!match) return null;
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) ? seconds : null;
  }

  /**
   * Rounded origin, exact destination.
   *
   * The destination is a fixed address and should key precisely. The origin is
   * a moving phone, and rounding it to ~110 m is what turns a stream of
   * distinct GPS fixes into repeated cache hits — which is the difference
   * between one billed call a minute and one every few seconds.
   */
  private cacheKey(
    origin: { lat: number; lng: number },
    toLat: number,
    toLng: number,
  ): string {
    const p = this.options.originPrecision;
    return (
      `route:google:${origin.lat.toFixed(p)},${origin.lng.toFixed(p)}` +
      `:${toLat.toFixed(6)},${toLng.toFixed(6)}`
    );
  }

  private async readCache(key: string): Promise<TravelEstimate | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as TravelEstimate) : null;
    } catch {
      // A cache that is down is a cost problem, not a correctness one.
      return null;
    }
  }

  private async writeCache(key: string, value: TravelEstimate): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(value),
        this.options.cacheTtlSeconds,
      );
    } catch {
      // Same.
    }
  }
}
