import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import type {
  CityBounds,
  GeocoderPort,
  PlaceSearchResult,
  ReverseGeocodeResult,
} from './geocoding.types';
import { boundsSizeKm } from './geocoding.types';

/** Hits per search. Matches the Google adapter — see `MAX_SEARCH_RESULTS`. */
const MAX_SEARCH_RESULTS = 8;

interface NominatimSearchResult {
  display_name?: string;
  /** [minLat, maxLat, minLng, maxLng], as strings. */
  boundingbox?: string[];
  place_id?: number;
  /** Strings here, unlike the reverse path where the pin was ours already. */
  lat?: string;
  lon?: string;
  address?: Record<string, string | undefined>;
}

interface NominatimResponse {
  display_name?: string;
  licence?: string;
  address?: Record<string, string | undefined>;
  error?: string;
}

/**
 * OpenStreetMap Nominatim — the free path, and the default when no Google key
 * is configured.
 *
 * Moved here from module 2 unchanged in behaviour. It lived in `customers`
 * because address-saving was the only caller; once module 13 needed it too,
 * keeping it there would have meant either a dependency cycle or a second
 * client with its own cache and its own rate limiter — and the rate limiter is
 * the entire point.
 */
@Injectable()
export class NominatimGeocoder implements GeocoderPort {
  /**
   * OpenStreetMap's usage policy is **one request per second for the whole
   * application**, not per user or per instance. Exceeding it gets an IP
   * blocked, so callers that loop must pace themselves by this.
   */
  readonly minIntervalMs = 1100;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /**
   * A city name to its box, from OpenStreetMap's `/search`.
   *
   * Nominatim returns `boundingbox` as **strings in [minLat, maxLat, minLng,
   * maxLng] order** — not the `[southwest, northeast]` pair Google uses. Getting
   * that order wrong produces a box that is silently transposed rather than
   * obviously broken, which is why it is parsed explicitly here.
   *
   * Subject to the same one-request-per-second courtesy limit as the reverse
   * direction, and the same shared Redis slot enforces it.
   */
  async searchPlaces(query: string): Promise<PlaceSearchResult[]> {
    const normalised = query.trim().replace(/\s+/g, ' ').toLowerCase();
    const cacheKey = `geo:search:nominatim:${normalised}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as PlaceSearchResult[];

    const userAgent = this.config.get<string>('NOMINATIM_USER_AGENT')?.trim();
    if (!userAgent) {
      throw new ServiceUnavailableException('Geocoding is not configured');
    }

    /* The same one-per-second slot every other call here takes. Nominatim
       enforces it per application, not per endpoint. */
    const acquired = await this.redis.setIfAbsent(
      'geo:nominatim:request-slot',
      '1',
      1,
    );
    if (!acquired) {
      throw new ServiceUnavailableException('Geocoder is busy; retry shortly');
    }

    const baseUrl = this.config.get<string>(
      'NOMINATIM_BASE_URL',
      'https://nominatim.openstreetmap.org',
    );
    const url = new URL('/search', baseUrl);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', normalised);
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', String(MAX_SEARCH_RESULTS));
    /* Where the platform operates. Without it "indore" also matches a street
       in the United States, and narrowing upstream keeps the count honest. */
    url.searchParams.set('countrycodes', 'in');

    let body: NominatimSearchResult[];
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': this.config.get<string>(
            'NOMINATIM_ACCEPT_LANGUAGE',
            'en',
          ),
        },
        signal: AbortSignal.timeout(
          this.numberConfig('NOMINATIM_TIMEOUT_MS', 4000),
        ),
      });
      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Geocoder returned HTTP ${response.status}`,
        );
      }
      body = (await response.json()) as NominatimSearchResult[];
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Geocoder is unreachable');
    }

    /* No match is a real answer, not a failure — see `GeocoderPort`. */
    if (!Array.isArray(body)) return [];

    const results = body
      .map((entry, index): PlaceSearchResult | null => {
        const lat = Number(entry.lat);
        const lng = Number(entry.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

        const address = entry.address ?? {};
        const street = [address.house_number, address.road ?? address.building]
          .filter(Boolean)
          .join(', ');
        const area = address.neighbourhood ?? address.suburb;
        const city =
          address.city ?? address.town ?? address.village ?? address.county;

        /*
         * Nominatim leads `display_name` with the most specific part, so its
         * first segment is a usable title when the structured fields are thin
         * — unlike Google, whose line leads with a building number.
         */
        const title =
          street || area || city || entry.display_name?.split(', ')[0] || '';
        if (!title) return null;

        const subtitle = [area, city, address.postcode]
          .filter((part): part is string => !!part && part !== title)
          .join(', ');

        return {
          id: `nominatim:${entry.place_id ?? index}`,
          title,
          subtitle:
            subtitle ||
            (entry.display_name && entry.display_name !== title
              ? entry.display_name
              : ''),
          lat,
          lng,
        };
      })
      .filter((result): result is PlaceSearchResult => result !== null);

    await this.redis.set(
      cacheKey,
      JSON.stringify(results),
      this.numberConfig('NOMINATIM_CACHE_TTL_SECONDS', 86400),
    );
    return results;
  }

  async geocodeCity(name: string): Promise<CityBounds> {
    const cacheKey = `geo:city:nominatim:${name.trim().toLowerCase()}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as CityBounds;

    const userAgent = this.config.get<string>('NOMINATIM_USER_AGENT')?.trim();
    if (!userAgent) {
      throw new ServiceUnavailableException('Geocoding is not configured');
    }

    const acquired = await this.redis.setIfAbsent(
      'geo:nominatim:request-slot',
      '1',
      1,
    );
    if (!acquired) {
      throw new ServiceUnavailableException('Geocoder is busy; retry shortly');
    }

    const baseUrl = this.config.get<string>(
      'NOMINATIM_BASE_URL',
      'https://nominatim.openstreetmap.org',
    );
    const url = new URL('/search', baseUrl);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', name);
    url.searchParams.set('limit', '1');

    let body: NominatimSearchResult[];
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': this.config.get<string>(
            'NOMINATIM_ACCEPT_LANGUAGE',
            'en',
          ),
        },
        signal: AbortSignal.timeout(
          this.numberConfig('NOMINATIM_TIMEOUT_MS', 4000),
        ),
      });
      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Geocoder returned HTTP ${response.status}`,
        );
      }
      body = (await response.json()) as NominatimSearchResult[];
    } catch (error) {
      if (
        error instanceof ServiceUnavailableException ||
        error instanceof UnprocessableEntityException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException('Geocoder is unreachable');
    }

    const first = body?.[0];
    const box = first?.boundingbox;
    if (!first || !box || box.length !== 4) {
      throw new UnprocessableEntityException(
        `No place with an extent could be found for "${name}"`,
      );
    }

    // [minLat, maxLat, minLng, maxLng], as strings.
    const [minLat, maxLat, minLng, maxLng] = box.map(Number);
    if ([minLat, maxLat, minLng, maxLng].some((n) => !Number.isFinite(n))) {
      throw new UnprocessableEntityException(
        `"${name}" returned a bounding box that could not be read`,
      );
    }

    const result: CityBounds = {
      matchedName: first.display_name ?? name,
      minLat,
      maxLat,
      minLng,
      maxLng,
      ...boundsSizeKm({ minLat, maxLat, minLng, maxLng }),
      provider: 'nominatim',
      attribution:
        'Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright',
    };

    await this.redis.set(
      cacheKey,
      JSON.stringify(result),
      this.numberConfig('NOMINATIM_CACHE_TTL_SECONDS', 2_592_000),
    );
    return result;
  }

  async reverseGeocode(
    lat: number,
    lng: number,
  ): Promise<ReverseGeocodeResult> {
    const cacheKey = `geo:reverse:nominatim:${lat.toFixed(6)}:${lng.toFixed(6)}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as ReverseGeocodeResult;

    const userAgent = this.config.get<string>('NOMINATIM_USER_AGENT')?.trim();
    if (!userAgent) {
      // Nominatim rejects requests without an identifying User-Agent, so this
      // is a configuration error rather than a transient outage.
      throw new ServiceUnavailableException(
        'Reverse geocoding is not configured',
      );
    }

    // Redis makes the one-per-second limit shared across every instance,
    // which a per-process timer could not do.
    const acquired = await this.redis.setIfAbsent(
      'geo:nominatim:request-slot',
      '1',
      1,
    );
    if (!acquired) {
      throw new ServiceUnavailableException(
        'Reverse geocoder is busy; retry shortly',
      );
    }

    const baseUrl = this.config.get<string>(
      'NOMINATIM_BASE_URL',
      'https://nominatim.openstreetmap.org',
    );
    const url = new URL('/reverse', baseUrl);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('layer', 'address');
    url.searchParams.set('zoom', '18');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': this.config.get<string>(
            'NOMINATIM_ACCEPT_LANGUAGE',
            'en',
          ),
        },
        signal: AbortSignal.timeout(
          this.numberConfig('NOMINATIM_TIMEOUT_MS', 4000),
        ),
      });
      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Reverse geocoder returned HTTP ${response.status}`,
        );
      }

      const body = (await response.json()) as NominatimResponse;
      if (!body.display_name || body.error) {
        throw new UnprocessableEntityException(
          'No address could be resolved for this pin',
        );
      }

      const address = body.address ?? {};
      const result: ReverseGeocodeResult = {
        addressLine: body.display_name,
        cityCandidates: [
          ...new Set(
            [
              address.city,
              address.town,
              address.municipality,
              address.village,
              address.county,
            ].filter((value): value is string => !!value),
          ),
        ],
        // OpenStreetMap's neighbourhood layer, coarsest-last. `suburb` is the
        // usual answer in an Indian city; `residential` catches named colonies
        // that were never tagged as a suburb.
        localityCandidates: [
          ...new Set(
            [
              address.suburb,
              address.neighbourhood,
              address.quarter,
              address.city_district,
              address.residential,
            ].filter((value): value is string => !!value),
          ),
        ],
        stateName: address.state ?? null,
        postalCode: address.postcode ?? null,
        provider: 'nominatim',
        attribution:
          body.licence ?? 'Data © OpenStreetMap contributors, ODbL 1.0',
      };

      await this.redis.set(
        cacheKey,
        JSON.stringify(result),
        this.numberConfig('NOMINATIM_CACHE_TTL_SECONDS', 2_592_000),
      );
      return result;
    } catch (error) {
      if (
        error instanceof ServiceUnavailableException ||
        error instanceof UnprocessableEntityException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException('Reverse geocoder is unavailable');
    }
  }

  private numberConfig(name: string, fallback: number): number {
    const value = Number(this.config.get<string>(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
