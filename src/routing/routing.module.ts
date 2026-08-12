import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildGoogleRoutesOptions,
  resolveRouterProvider,
} from '../config/routing.config';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { GoogleRouter } from './google.router';
import { HaversineRouter } from './haversine.router';
import { ROUTER, type RoutingPort } from './routing.types';

/**
 * Road travel time, for whoever needs it.
 *
 * ## Infrastructure, not a module — the same argument as geocoding
 *
 * It sits beside `geocoding/` and `redis/` for the reason spelled out there:
 * three modules need it and none can own it. Dispatch (5) ranks candidates by
 * travel time, Bookings (4) publishes a customer ETA, and Geo (13) is where
 * routing conceptually belongs — but `geo → bookings` already, so putting the
 * adapter in `geo` and having `bookings` import it closes a cycle.
 *
 * Global, like `GeocodingModule`, so a consumer injects `ROUTER` without
 * threading an import through four modules.
 *
 * ## Which adapter answers
 *
 * Google when a key is present, straight lines otherwise. One difference from
 * the geocoder is worth stating: **the fallback here is genuinely useful**.
 * A keyless deployment still dispatches correctly, because ranking only needs
 * the *ordering* to be right and crow-flight preserves it at city scale. What
 * it does not get is a customer-facing ETA — `TravelEstimate.source` says
 * which kind of answer it is, and the tracking path refuses to publish a
 * `haversine` one as an arrival time.
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [
    HaversineRouter,
    {
      provide: ROUTER,
      inject: [ConfigService, RedisService, HaversineRouter],
      useFactory: (
        config: ConfigService,
        redis: RedisService,
        haversine: HaversineRouter,
      ): RoutingPort => {
        const env = envOf(config);
        const options = buildGoogleRoutesOptions(env);
        const chosen =
          resolveRouterProvider(env) === 'google' && options
            ? new GoogleRouter(options, redis, haversine)
            : haversine;

        const logger = new Logger('RoutingModule');
        if (chosen.name === 'google') {
          logger.log(
            'Travel time via Google Routes — traffic-aware, cached for ' +
              `${options?.cacheTtlSeconds}s, falling back to straight lines on failure. ` +
              'The Routes API must be enabled on the key separately from Geocoding.',
          );
        } else {
          logger.warn(
            'Travel time via straight-line distance. Dispatch ranking is ' +
              'unaffected, but no customer-facing ETA will be published — set ' +
              'GOOGLE_MAPS_API_KEY (with the Routes API enabled) to turn it on.',
          );
        }
        return chosen;
      },
    },
  ],
  exports: [ROUTER, HaversineRouter],
})
export class RoutingModule {}

function envOf(config: ConfigService): Record<string, string | undefined> {
  return {
    NODE_ENV: config.get<string>('NODE_ENV'),
    ROUTING_PROVIDER: config.get<string>('ROUTING_PROVIDER'),
    GOOGLE_ROUTES_API_KEY: config.get<string>('GOOGLE_ROUTES_API_KEY'),
    GOOGLE_MAPS_API_KEY: config.get<string>('GOOGLE_MAPS_API_KEY'),
    GOOGLE_ROUTES_BASE_URL: config.get<string>('GOOGLE_ROUTES_BASE_URL'),
    GOOGLE_MAPS_REGION: config.get<string>('GOOGLE_MAPS_REGION'),
    ROUTING_TIMEOUT_MS: config.get<string>('ROUTING_TIMEOUT_MS'),
    ROUTING_CACHE_TTL_SECONDS: config.get<string>('ROUTING_CACHE_TTL_SECONDS'),
    ROUTING_ORIGIN_PRECISION: config.get<string>('ROUTING_ORIGIN_PRECISION'),
  };
}
