import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';

export interface ReverseGeocodeResult {
  addressLine: string;
  cityCandidates: string[];
  stateName: string | null;
  attribution: string;
}

interface NominatimResponse {
  display_name?: string;
  licence?: string;
  address?: Record<string, string | undefined>;
  error?: string;
}

/**
 * Narrow OpenStreetMap Nominatim adapter used only for user-triggered reverse
 * geocoding. Results are cached before the public service is called again.
 */
@Injectable()
export class AddressGeocoderService {
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async reverseGeocode(
    pinLat: number,
    pinLng: number,
  ): Promise<ReverseGeocodeResult> {
    const cacheKey = `geo:reverse:${pinLat.toFixed(6)}:${pinLng.toFixed(6)}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as ReverseGeocodeResult;

    const userAgent = this.config.get<string>('NOMINATIM_USER_AGENT')?.trim();
    if (!userAgent) {
      throw new ServiceUnavailableException(
        'Reverse geocoding is not configured',
      );
    }

    // The public Nominatim policy permits at most one request per second for
    // the whole application. Redis makes that limit shared by every instance.
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
    url.searchParams.set('lat', String(pinLat));
    url.searchParams.set('lon', String(pinLng));

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.numberConfig('NOMINATIM_TIMEOUT_MS', 4000),
    );

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': this.config.get<string>(
            'NOMINATIM_ACCEPT_LANGUAGE',
            'en',
          ),
        },
        signal: controller.signal,
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
      const cityCandidates = unique(
        [
          address.city,
          address.town,
          address.municipality,
          address.village,
          address.county,
        ].filter((value): value is string => !!value),
      );
      const result: ReverseGeocodeResult = {
        addressLine: body.display_name,
        cityCandidates,
        stateName: address.state ?? null,
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
    } finally {
      clearTimeout(timeout);
    }
  }

  private numberConfig(name: string, fallback: number): number {
    const value = Number(this.config.get<string>(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
