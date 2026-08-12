import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildGoogleMapsOptions,
  resolveGeocoderProvider,
} from '../config/google-maps.config';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { GEOCODER, type GeocoderPort } from './geocoding.types';
import { GoogleGeocoder } from './google.geocoder';
import { NominatimGeocoder } from './nominatim.geocoder';

/**
 * Turning a pin into words, for whoever needs it.
 *
 * ## Why this is infrastructure and not a module
 *
 * It sits beside `redis/` and `storage/` rather than under `modules/` because
 * it is an external-service adapter, not a domain. That placement is also what
 * makes it *possible*: module 2 saves addresses and module 13 names grid
 * cells, and both need geocoding — but `customers` and `geo` already sit on
 * opposite sides of a chain (`geo → bookings → customers`), so putting the
 * adapter in either one creates a cycle. Neither owns it; both import it.
 *
 * Global, like `PrismaModule`, so consumers inject `GEOCODER` without
 * threading an import through four modules.
 *
 * ## Which adapter answers
 *
 * Google when `GOOGLE_MAPS_API_KEY` is set, Nominatim otherwise —
 * presence-based, exactly like the OTP provider swapping the mock for Slide.
 * `GEOCODER_PROVIDER` overrides, and refuses to start if it names Google
 * without a key rather than silently using the other one.
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [
    NominatimGeocoder,
    {
      provide: GEOCODER,
      inject: [ConfigService, RedisService, NominatimGeocoder],
      useFactory: (
        config: ConfigService,
        redis: RedisService,
        nominatim: NominatimGeocoder,
      ): GeocoderPort => {
        const env = envOf(config);
        const options = buildGoogleMapsOptions(env);
        // Constructed here rather than as its own provider because it cannot
        // exist at all without a key, and a provider that resolves to null is
        // a worse lie than one that is simply never built.
        const chosen =
          resolveGeocoderProvider(env) === 'google' && options
            ? new GoogleGeocoder(options, redis)
            : nominatim;

        new Logger('GeocodingModule').log(
          `Reverse geocoding via ${chosen instanceof GoogleGeocoder ? 'Google' : 'Nominatim'}` +
            (chosen.minIntervalMs
              ? ` — paced at ${chosen.minIntervalMs}ms between calls`
              : ' — no politeness interval, bulk passes run at full speed'),
        );
        return chosen;
      },
    },
  ],
  exports: [GEOCODER],
})
export class GeocodingModule {}

function envOf(config: ConfigService): Record<string, string | undefined> {
  return {
    NODE_ENV: config.get<string>('NODE_ENV'),
    GEOCODER_PROVIDER: config.get<string>('GEOCODER_PROVIDER'),
    GOOGLE_MAPS_API_KEY: config.get<string>('GOOGLE_MAPS_API_KEY'),
    GOOGLE_MAPS_BASE_URL: config.get<string>('GOOGLE_MAPS_BASE_URL'),
    GOOGLE_MAPS_REGION: config.get<string>('GOOGLE_MAPS_REGION'),
    GOOGLE_MAPS_LANGUAGE: config.get<string>('GOOGLE_MAPS_LANGUAGE'),
    GOOGLE_MAPS_TIMEOUT_MS: config.get<string>('GOOGLE_MAPS_TIMEOUT_MS'),
    GOOGLE_MAPS_CACHE_TTL_SECONDS: config.get<string>(
      'GOOGLE_MAPS_CACHE_TTL_SECONDS',
    ),
  };
}
