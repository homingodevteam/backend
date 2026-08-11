import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import {
  AreaDto,
  LocationCatalogDto,
  LocationCatalogQueryDto,
  ResolveLocationQueryDto,
  ServiceabilityDto,
} from './dto/area.dto';
import { LocationService } from './location.service';

/**
 * The customer app's two location questions, both answered server-side.
 *
 * Unauthenticated on purpose: a customer must be able to find out whether we
 * operate at their address **before** creating an account, and neither answer
 * discloses anything a competitor could not get by dropping a pin themselves.
 *
 * Neither endpoint accepts an `areaId`. The client sends a pin; the server
 * decides which area it is. That direction is the whole security model here —
 * a client that could name its own area could book a service anywhere.
 */
@ApiTags('Geo')
@Controller('geo')
export class GeoController {
  constructor(private readonly location: LocationService) {}

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
  @ApiOkEnvelope(AreaDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.BAD_REQUEST)
  areasForService(@Param('serviceId') serviceId: string): Promise<AreaDto[]> {
    return this.location.listAreasForService(serviceId);
  }
}
