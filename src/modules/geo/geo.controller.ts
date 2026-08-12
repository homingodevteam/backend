import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import {
  LocationCatalogDto,
  LocationCatalogQueryDto,
  MyLocationDto,
  PublicAreaDto,
  ReverseGeocodeDto,
  ReverseGeocodeQueryDto,
  ResolveLocationQueryDto,
  ServiceabilityDto,
} from './dto/area.dto';
import { LocationService } from './location.service';

/**
 * Every location question the customer app asks, answered server-side.
 *
 * The launch sequence these are shaped around:
 *
 * 1. `GET /geo/my-location` — do you already know where I am? A returning
 *    customer skips straight to a catalogue; the GPS permission dialog becomes
 *    something the app asks for when it needs precision, not a wall on launch.
 * 2. If not, prompt for GPS, then `GET /geo/reverse-geocode` — turn the pin
 *    into an address and an area in one call.
 * 3. `GET /geo/catalog` — what can I actually book here.
 *
 * **Only `my-location` is authenticated**, because it is the only one that
 * reads something belonging to a particular customer. The rest are public on
 * purpose: someone must be able to find out whether we serve their street
 * before creating an account, and none of those answers discloses anything a
 * competitor could not get by dropping a pin themselves.
 *
 * **No endpoint here accepts an `areaId`.** The client sends a pin; the server
 * decides which area it is. That direction is the whole security model — a
 * client that could name its own area could book a service anywhere.
 */
@ApiTags('Geo')
@Controller('geo')
export class GeoController {
  constructor(private readonly location: LocationService) {}

  @Get('my-location')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ActorTypeGuard)
  @RequireActorType('customer')
  @ApiOperation({
    summary: 'Where do you already think I am?',
    description:
      '**Call this on app open, before prompting for location permission.**\n\n' +
      'A returning customer with a saved address gets their catalogue ' +
      'immediately, and the GPS dialog becomes something the app asks for ' +
      'when it needs precision rather than a wall on launch.\n\n' +
      'This does **not** read the device GPS — nothing on a server can. It ' +
      'reports the best address we already hold, re-resolved to a current ' +
      'area.\n\n' +
      '`source: null` means we know nothing yet: a new or guest customer. ' +
      'That is a normal first-run state, not an error — prompt for GPS and ' +
      'call `/geo/reverse-geocode` with the pin.',
  })
  @ApiOkEnvelope(MyLocationDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  myLocation(@CurrentUser() user: AuthenticatedUser): Promise<MyLocationDto> {
    return this.location.myLocation(user.id);
  }

  @Get('reverse-geocode')
  @ApiOperation({
    summary: 'Turn a pin into a human-readable address',
    description:
      'For the moment a customer drags a map pin: render the address **and** ' +
      'find out whether we operate there, in one call, so the two cannot ' +
      'disagree on screen.\n\n' +
      'The address comes from Google when a key is configured and from ' +
      'OpenStreetMap otherwise — `provider` says which. The **area** is always ' +
      "resolved from our own grid; a provider's idea of a neighbourhood has " +
      'nothing to do with where we have posted Pros.\n\n' +
      '`attribution` **must be displayed** wherever the address is shown. Both ' +
      'providers require it.',
  })
  @ApiOkEnvelope(ReverseGeocodeDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  reverseGeocode(
    @Query() query: ReverseGeocodeQueryDto,
  ): Promise<ReverseGeocodeDto> {
    return this.location.reverseGeocode(query.lat, query.lng);
  }

  @Get('catalog')
  @ApiOperation({
    summary: 'What can I book at this pin?',
    description:
      'The catalogue answered for one location — **call this first**, before ' +
      'showing anything bookable. Every other check here answers "can I book ' +
      '*this* service here" one service at a time, which is the wrong end of ' +
      'the funnel: a customer would pick a service, fill in a booking, and ' +
      'only then be told it is not offered where they live.\n\n' +
      'Unavailable services are **returned and flagged, not hidden** — a ' +
      'thinly-mapped area would otherwise look like an empty product rather ' +
      'than a new one. A pin outside every area returns everything as ' +
      'unavailable rather than an error; the customer is still allowed to look.',
  })
  @ApiOkEnvelope(LocationCatalogDto)
  @ApiErrorEnvelope(HttpStatus.BAD_REQUEST)
  catalog(
    @Query() query: LocationCatalogQueryDto,
  ): Promise<LocationCatalogDto> {
    const { lat, lng, ...browse } = query;
    return this.location.catalogForLocation({
      lat,
      lng,
      query: browse,
    }) as unknown as Promise<LocationCatalogDto>;
  }

  @Get('serviceability')
  @ApiOperation({
    summary: 'Can we serve this pin, and this service at it?',
    description:
      'Send the coordinates Google Maps gave you — never an area id. Omit ' +
      '`serviceId` to ask only whether we operate at the location. ' +
      '**Advisory only:** booking re-runs this check server-side, so a stale ' +
      '`true` here cannot create an unserviceable booking.',
  })
  @ApiOkEnvelope(ServiceabilityDto)
  @ApiErrorEnvelope(HttpStatus.BAD_REQUEST)
  check(@Query() query: ResolveLocationQueryDto): Promise<ServiceabilityDto> {
    return this.location.checkServiceability({
      lat: query.lat,
      lng: query.lng,
      serviceId: query.serviceId,
    });
  }

  @Get('services/:serviceId/areas')
  @ApiOperation({
    summary: 'Everywhere a service is live',
    description: 'For a "we are available in…" list. Active areas only.',
  })
  @ApiOkEnvelope(PublicAreaDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.BAD_REQUEST)
  areasForService(
    @Param('serviceId') serviceId: string,
  ): Promise<PublicAreaDto[]> {
    return this.location.listAreasForService(serviceId);
  }
}
