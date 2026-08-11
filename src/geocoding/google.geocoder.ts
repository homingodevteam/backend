import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { GoogleMapsOptions } from '../config/google-maps.config';
import { RedisService } from '../redis/redis.service';
import type { GeocoderPort, ReverseGeocodeResult } from './geocoding.types';

interface GoogleAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

interface GoogleGeocodeResponse {
  status: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    address_components?: GoogleAddressComponent[];
  }>;
}

/**
 * Google's Geocoding API — the paid, accurate path.
 *
 * Chosen automatically when `GOOGLE_MAPS_API_KEY` is present. Its advantage
 * over Nominatim on Indian addresses is substantial: better locality naming,
 * far better coverage of unnamed roads and new developments, and **no
 * politeness interval**, which is why `minIntervalMs` is zero here and 1100 on
 * the free adapter.
 *
 * This is a **server-side** key and must be restricted by IP in the Google
 * console, not by HTTP referrer — a referrer restriction does nothing for a
 * backend caller and leaves the key usable by anyone who finds it.
 */
@Injectable()
export class GoogleGeocoder implements GeocoderPort {
  private readonly logger = new Logger(GoogleGeocoder.name);

  /** A paid quota, not a courtesy limit. Callers need not pace themselves. */
  readonly minIntervalMs = 0;

  constructor(
    private readonly options: GoogleMapsOptions,
    private readonly redis: RedisService,
  ) {}

  async reverseGeocode(
    lat: number,
    lng: number,
  ): Promise<ReverseGeocodeResult> {
    // Provider-scoped so switching adapters cannot serve a result shaped by
    // the other one — the two format `addressLine` quite differently.
    const cacheKey = `geo:reverse:google:${lat.toFixed(6)}:${lng.toFixed(6)}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as ReverseGeocodeResult;

    const url = new URL('/maps/api/geocode/json', this.options.baseUrl);
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('key', this.options.apiKey);
    url.searchParams.set('language', this.options.language);
    if (this.options.region)
      url.searchParams.set('region', this.options.region);

    const body = await this.fetchJson(url);
    const result = this.toResult(body);

    await this.redis.set(
      cacheKey,
      JSON.stringify(result),
      this.options.cacheTtlSeconds,
    );
    return result;
  }

  private async fetchJson(url: URL): Promise<GoogleGeocodeResponse> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Geocoder returned HTTP ${response.status}`,
        );
      }
      return (await response.json()) as GoogleGeocodeResponse;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Geocoder is unavailable');
    }
  }

  private toResult(body: GoogleGeocodeResponse): ReverseGeocodeResult {
    // ORDER MATTERS, and getting it wrong is subtle: every failing status
    // *also* arrives with no results, so testing for emptiness first reports a
    // denied key or an exhausted quota as "no address here" — turning our
    // billing problem into the customer's coverage problem, on every pin, with
    // nothing in the logs to say otherwise. Status is judged first.
    if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
      // Logged in full because none of it should reach a customer:
      // REQUEST_DENIED is a misconfigured key and OVER_QUERY_LIMIT is a
      // billing problem, and both look identical to whoever dropped the pin.
      this.logger.error(
        `Google geocoding failed: ${body.status}` +
          (body.error_message ? ` — ${body.error_message}` : ''),
      );
      throw new ServiceUnavailableException('Geocoder is unavailable');
    }

    // ZERO_RESULTS is a real answer about the sea or a desert, not a failure.
    if (!body.results?.length) {
      throw new UnprocessableEntityException(
        'No address could be resolved for this pin',
      );
    }

    const best = body.results[0];
    const components = best.address_components ?? [];

    const named = (type: string): string | undefined =>
      components.find((component) => component.types.includes(type))?.long_name;

    // Ordered best-first, because module 2 matches these against the City
    // table by name and the first genuine match wins. `locality` is the city
    // proper; the administrative levels are the fallbacks for a pin that sits
    // outside any named settlement.
    const cityCandidates = [
      named('locality'),
      named('postal_town'),
      named('administrative_area_level_3'),
      named('administrative_area_level_2'),
    ].filter((value): value is string => !!value);

    return {
      addressLine: best.formatted_address ?? '',
      cityCandidates: [...new Set(cityCandidates)],
      stateName: named('administrative_area_level_1') ?? null,
      postalCode: named('postal_code') ?? null,
      provider: 'google',
      // Google's terms require this to be displayed wherever the result is.
      attribution: 'Map data ©2026 Google',
    };
  }
}
