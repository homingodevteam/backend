import { Inject, Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import {
  NoOpServiceabilityService,
  SERVICEABILITY_PORT,
} from '../bookings/ports/serviceability.port';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomersModule } from '../customers/customers.module';
import { IdentityModule } from '../identity/identity.module';
import { ProsModule } from '../pros/pros.module';
import {
  PRO_LOCATION_RESOLVER_PORT,
  ProLocationResolverDelegate,
} from '../pros/ports/pro-location-resolver.port';
import { AdminAreasController } from './admin-areas.controller';
import { AreaNamingService } from './area-naming.service';
import { AreasService } from './areas.service';
import { GeoController } from './geo.controller';
import { LocationService } from './location.service';
import { RealServiceabilityAdapter } from './real-serviceability.adapter';
import { ProLocationAdapter } from './pro-location.adapter';

/**
 * Module 13 · Geo & Routing — first instalment: **service areas**.
 *
 * Owns `Area`, `AreaService` and `ProArea`, and the single function that turns
 * a pin into an area.
 *
 * ## What this instalment is
 *
 * Before it, "can this customer book this service" had exactly one answer:
 * `City.isActive`. A city was open or shut and every service in it was equally
 * available everywhere, which cannot express what the business does. `Area` is
 * the unit that fixes that, and `AreaService` is the answer.
 *
 * ## What it deliberately is not, yet
 *
 * - **No Google Maps.** Reverse geocoding is still module 2's Nominatim
 *   adapter. Places/Routes land in the next instalment, behind the same shape.
 * - **No ETA.** `TravelTimePort` still resolves to haversine, and module 4's
 *   tracking view still publishes a null ETA rather than a number nobody can
 *   stand behind.
 * - **No PostGIS.** An area is a rectangle, and the geometry question lives
 *   in `LocationService.resolveArea` — one function to replace when polygons
 *   are worth it.
 * - **No schedules.** Dispatch still has no roster; `Pro.isAvailable` is a
 *   straight on/off flag.
 *
 * ## The one thing to know before enabling it
 *
 * `geo.enforceAreaServiceAvailability` ships **false**. The admin enforcement
 * endpoint refuses to enable it until every active area has a current address,
 * at least one service, and an approved capable professional. See
 * `LocationService.resolveForBooking` for the booking-time gate.
 */
@Module({
  // BookingsModule for PlatformSettingsService — the per-city enforcement
  // flag. Nothing here depends on bookings themselves, and the reverse
  // dependency (booking asking "is this serviceable?") goes through a port
  // module 4 owns, so there is no cycle.
  // CatalogModule for the location-filtered catalogue — the app's first
  // screen asks "what can I book here", which needs both halves.
  imports: [
    IdentityModule,
    BookingsModule,
    CatalogModule,
    CustomersModule,
    ProsModule,
  ],
  controllers: [GeoController, AdminAreasController],
  providers: [
    LocationService,
    AreasService,
    AreaNamingService,
    RealServiceabilityAdapter,
    ProLocationAdapter,
  ],
  exports: [LocationService, AreasService],
})
export class GeoModule {
  /**
   * Registers area resolution into module 4's delegate at boot, the same way
   * modules 5 and 7 do. Presence of `GeoModule` in `AppModule` is what makes
   * bookings start recording an area.
   *
   * Registering is safe on its own — it only starts *recording*. Whether the
   * gate can *reject* anything is a separate, per-city setting that ships off.
   */
  constructor(
    @Inject(SERVICEABILITY_PORT) delegate: NoOpServiceabilityService,
    adapter: RealServiceabilityAdapter,
    @Inject(PRO_LOCATION_RESOLVER_PORT)
    proLocationDelegate: ProLocationResolverDelegate,
    proLocationAdapter: ProLocationAdapter,
  ) {
    delegate.register(adapter);
    proLocationDelegate.register(proLocationAdapter);
  }
}
