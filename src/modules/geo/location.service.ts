import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { GEOCODER, type GeocoderPort } from '../../geocoding/geocoding.types';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import { BrowseServicesQueryDto } from '../catalog/dto/browse-services-query.dto';
import { ServiceCatalogService } from '../catalog/service-catalog.service';
import { CustomersService } from '../customers/customers.service';
import {
  boxAreaSqKm,
  GEO_SETTINGS,
  isValidCoordinate,
  type ResolvedArea,
  type ServiceabilityResult,
} from './geo.types';

@Injectable()
export class LocationService {
  private readonly logger = new Logger(LocationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly catalog: ServiceCatalogService,
    @Inject(GEOCODER) private readonly geocoder: GeocoderPort,
    private readonly customers: CustomersService,
  ) {}

  /**
   * A pin becomes an area. **The only place that mapping happens**, and the
   * only thing that has to change if rectangles are ever replaced by polygons.
   *
   * ## Why this is a query and not a loop
   *
   * Areas are axis-aligned rectangles with **half-open** bounds
   * (`min <= value < max`), so "which area contains this pin" is four range
   * comparisons the database can answer from an index. Nothing is loaded into
   * memory to be measured, and there is no trigonometry on the request path.
   *
   * The half-open asymmetry is what makes a tiled grid deterministic. Adjacent
   * cells share an edge *exactly* — one cell's `maxLat` is bit-identical to
   * its neighbour's `minLat`, because the generator derives both from the same
   * arithmetic. Closed bounds would put a pin on that edge in two cells at
   * once; half-open bounds put it in exactly one.
   *
   * ## When more than one matches
   *
   * A generated grid never produces two matches. Hand-drawn areas can — most
   * usefully on purpose, where a small precise box sits inside a larger
   * fallback. The **smallest box wins**, which reads as "the most specific
   * answer", with the id as a final tiebreak so the result is stable rather
   * than merely usually-stable.
   *
   * @returns the resolved area, or `null` when the pin is inside no active area
   */
  async resolveArea(lat: number, lng: number): Promise<ResolvedArea | null> {
    if (!isValidCoordinate(lat, lng)) {
      // Deliberately a 400 rather than "not serviceable". A NaN or swapped
      // coordinate matching no box would tell the customer we do not serve
      // them, when in fact the request was malformed.
      throw apiError(
        'That location could not be read',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'lat',
            message: 'lat and lng must be finite and in range',
            code: 'COORDINATES_INVALID',
          },
        ],
      );
    }

    const matches = await this.prisma.area.findMany({
      where: {
        isActive: true,
        city: { isActive: true },
        // Half-open: inclusive lower bound, exclusive upper.
        minLat: { lte: lat },
        maxLat: { gt: lat },
        minLng: { lte: lng },
        maxLng: { gt: lng },
      },
      include: { city: { select: { id: true, name: true } } },
    });

    if (matches.length === 0) return null;

    const [best] = matches.sort((a, b) => {
      const byArea = boxAreaSqKm(a) - boxAreaSqKm(b);
      return byArea !== 0 ? byArea : a.id.localeCompare(b.id);
    });

    return {
      areaId: best.id,
      areaName: best.name,
      cityId: best.cityId,
      cityName: best.city.name,
    };
  }

  /**
   * The customer-facing question: can I book **this service** at **this pin**?
   *
   * Two gates, in order, because they need different messages. "We do not
   * operate here at all" and "we operate here but not for that" are different
   * things to be told, and collapsing them into one string makes the product
   * feel broken in the first case and arbitrary in the second.
   */
  async checkServiceability(input: {
    lat: number;
    lng: number;
    serviceId?: string;
  }): Promise<ServiceabilityResult> {
    const area = await this.resolveArea(input.lat, input.lng);

    if (!area) {
      return {
        serviceable: false,
        area: null,
        reason: 'We are not operating in this location yet',
        code: 'LOCATION_NOT_SERVICEABLE',
      };
    }

    if (!input.serviceId) return { serviceable: true, area };

    const available = await this.isServiceAvailableInArea(
      area.areaId,
      input.serviceId,
    );

    if (!available) {
      return {
        serviceable: false,
        area,
        reason: `This service is not available in ${area.areaName} yet`,
        code: 'SERVICE_NOT_AVAILABLE_IN_AREA',
      };
    }

    return { serviceable: true, area };
  }

  /** One `AreaService` row, active. Nothing implicit. */
  async isServiceAvailableInArea(
    areaId: string,
    serviceId: string,
  ): Promise<boolean> {
    const row = await this.prisma.areaService.findUnique({
      where: { areaId_serviceId: { areaId, serviceId } },
      select: { isActive: true },
    });

    return row?.isActive === true;
  }

  /**
   * Booking's gate, and the reason it is not simply `checkServiceability`.
   *
   * **Enforcement is off by default**, per city, via
   * `geo.enforceAreaServiceAvailability`. That is not timidity — it is the
   * only safe way to add a mandatory gate to a running product. Areas do not
   * exist yet; a gate that shipped enabled would reject *every booking in
   * every city* the moment it deployed, because no pin resolves to an area
   * that has not been drawn.
   *
   * The intended sequence is: ship this off → ops maps a city → flip that
   * city's row to `true` → the gate becomes real there and nowhere else.
   *
   * While it is off, the area is still **resolved and recorded** on the
   * booking. So the data needed to check the mapping is accumulating before
   * the gate is switched on, which is what makes flipping it safe rather than
   * a leap.
   */
  async resolveForBooking(input: {
    lat: number;
    lng: number;
    serviceId: string;
    cityId: string;
  }): Promise<{ areaId: string | null }> {
    const enforce =
      (await this.settings.getString(
        GEO_SETTINGS.enforceAreaServiceAvailability,
        'false',
        input.cityId,
      )) === 'true';

    const result = await this.checkServiceability({
      lat: input.lat,
      lng: input.lng,
      serviceId: input.serviceId,
    });

    if (result.serviceable) return { areaId: result.area?.areaId ?? null };

    if (!enforce) {
      // Logged, not silent. This is the line that says how much work the gate
      // *would* have rejected, which is what tells ops whether their map is
      // complete enough to enforce.
      this.logger.warn(
        `Area gate not enforced for city ${input.cityId}: booking at ` +
          `(${input.lat}, ${input.lng}) for service ${input.serviceId} would ` +
          `have been refused — ${result.code}. Recording area ` +
          `${result.area?.areaId ?? 'none'} and continuing.`,
      );
      return { areaId: result.area?.areaId ?? null };
    }

    throw apiError(result.reason!, HttpStatus.CONFLICT, [
      {
        field:
          result.code === 'LOCATION_NOT_SERVICEABLE'
            ? 'addressId'
            : 'serviceId',
        message: 'Not available at this location',
        code: result.code!,
      },
    ]);
  }

  /**
   * Where we already believe this customer is, for the app's first screen.
   *
   * **This does not read a device's GPS** — nothing on a server can. It
   * answers the question a client should ask *before* prompting for location
   * permission: "do you already know where I am?" A returning customer with a
   * saved address gets their catalogue immediately, and the permission dialog
   * becomes something the app asks for when it actually needs precision,
   * rather than a wall on launch.
   *
   * `source` is null when we know nothing — a new or guest customer with no
   * saved address. That is the signal to ask for GPS and then call
   * `/geo/reverse-geocode`; it is not an error, and returning 404 for it would
   * make the ordinary first-run path look like a failure.
   */
  async myLocation(customerId: string) {
    // Already ordered default-first, then newest — so the first row is the
    // best guess without a second query or a sort here.
    const [address] = await this.customers.listAddresses(customerId);

    if (!address) {
      return {
        source: null,
        address: null,
        area: null,
        serviceable: false,
        reason: 'We do not have a saved address for you yet',
        code: 'NO_KNOWN_LOCATION',
      };
    }

    // Re-resolved rather than trusted: areas get redrawn, and an address saved
    // last month may sit in a cell that has since been renamed, split or
    // switched off.
    const area = await this.resolveArea(address.pinLat, address.pinLng);

    return {
      source: address.isDefault ? 'default_address' : 'recent_address',
      address: {
        id: address.id,
        label: address.label,
        addressLine: address.addressLine,
        pinLat: address.pinLat,
        pinLng: address.pinLng,
        cityId: address.cityId,
      },
      area,
      serviceable: area !== null,
      ...(area
        ? {}
        : {
            reason: 'We are not operating at your saved address yet',
            code: 'LOCATION_NOT_SERVICEABLE',
          }),
    };
  }

  /**
   * A pin turned into words, and the area it falls in.
   *
   * Both halves in one call deliberately. A client that has just dragged a map
   * pin wants to render "12 MG Road, Vijay Nagar" *and* know whether we serve
   * there; splitting that into two round trips lets the two disagree on
   * screen, with the address updating a beat before the availability banner.
   *
   * The address comes from whichever provider is configured — Google when a
   * key is present, OpenStreetMap otherwise. The **area does not**: that is
   * always resolved from our own grid, because a provider's idea of a
   * neighbourhood has nothing to do with where we have posted Pros.
   */
  async reverseGeocode(lat: number, lng: number) {
    // Both are pure reads and neither depends on the other, so the client
    // waits for the slower rather than the sum.
    const [geocoded, area] = await Promise.all([
      this.geocoder.reverseGeocode(lat, lng),
      this.resolveArea(lat, lng),
    ]);

    return { ...geocoded, area };
  }

  /**
   * The catalogue, answered for one pin. **The app's first screen.**
   *
   * Everything else here answers "can I book *this* service here?" one service
   * at a time. That is the wrong end of the funnel to ask it from: a customer
   * in Rau would browse the national catalogue, pick the deep clean, fill in a
   * booking, and only then be told it is not offered where they live. This
   * turns the question around — resolve the pin once, then say what is
   * bookable before anything is chosen.
   *
   * **Unavailable services are returned, flagged, not hidden.** Two reasons.
   * A thinly-mapped area would otherwise look like an empty product rather
   * than a new one, and "customers in Rau kept opening the deep clean" is the
   * demand signal that tells ops where to expand — which vanishes if the row
   * never reaches the client.
   *
   * A pin outside every area returns the catalogue with **everything**
   * unavailable and `area: null`, rather than an error. The customer is still
   * allowed to look.
   */
  async catalogForLocation(input: {
    lat: number;
    lng: number;
    query?: BrowseServicesQueryDto;
  }) {
    const [area, services] = await Promise.all([
      this.resolveArea(input.lat, input.lng),
      this.catalog.listServices(input.query ?? {}),
    ]);

    if (!area) {
      return {
        area: null,
        serviceable: false,
        reason: 'We are not operating in this location yet',
        code: 'LOCATION_NOT_SERVICEABLE',
        services: services.map((service) => ({
          ...service,
          isAvailable: false,
          unavailableReason: 'We are not operating in this location yet',
        })),
      };
    }

    // One query for the whole catalogue rather than one per service — this
    // runs on the first screen of every session.
    const rows = await this.prisma.areaService.findMany({
      where: { areaId: area.areaId, isActive: true },
      select: { serviceId: true },
    });
    const available = new Set(rows.map((row) => row.serviceId));

    return {
      area,
      serviceable: true,
      services: services.map((service) => {
        const isAvailable = available.has(service.id);
        return {
          ...service,
          isAvailable,
          unavailableReason: isAvailable
            ? null
            : `Not available in ${area.areaName} yet`,
        };
      }),
    };
  }

  /**
   * Every area a service is live in — what the customer app lists when
   * someone asks "where do you do this?".
   */
  async listAreasForService(serviceId: string) {
    const areas = await this.prisma.area.findMany({
      where: {
        isActive: true,
        city: { isActive: true },
        areaServices: { some: { serviceId, isActive: true } },
      },
      include: { city: { select: { id: true, name: true } } },
      orderBy: [{ cityId: 'asc' }, { name: 'asc' }],
    });

    // Mapped, not returned raw. A customer has no use for gridRef, nameSource
    // or the bounds, and publishing them would expose that "Vijay Nagar" is
    // really cell C3 of a grid nobody has reviewed (#34).
    return areas.map((area) => ({
      id: area.id,
      name: area.name,
      cityId: area.cityId,
      cityName: area.city.name,
    }));
  }
}
