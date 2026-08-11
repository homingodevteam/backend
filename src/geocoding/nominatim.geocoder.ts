import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import type { GeocoderPort, ReverseGeocodeResult } from './geocoding.types';

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
