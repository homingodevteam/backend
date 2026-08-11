import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { AreasService } from './areas.service';
import {
  AreaDto,
  AreaOverlapDto,
  BulkCreateAreasDto,
  CopyAreaServicesDto,
  CreateAreaDto,
  GenerateGridDto,
  SetAreaServiceDto,
  SetAreaServicesDto,
  SetProAreaDto,
  SetServiceAcrossAreasDto,
  UpdateAreaDto,
} from './dto/area.dto';

/**
 * Drawing the map, and saying what happens inside each piece of it.
 *
 * Guarded by `catalog.city.manage` — the same grant that already controls
 * cities. An area is a subdivision of a city, and whoever may open a city may
 * draw its areas; inventing a separate permission would split one decision
 * across two grants.
 */
@ApiTags('Admin — Areas')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/areas')
export class AdminAreasController {
  constructor(private readonly areas: AreasService) {}

  @Post('bulk')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Draw several rectangles by hand',
    description:
      'For refining a map after `generate-grid` has laid it, or for a city ' +
      'whose real boundaries do not suit a uniform grid. All-or-nothing. ' +
      '**Hand-drawn rectangles can leave gaps** — a generated grid cannot, ' +
      'which is why it is the default path. Check `/overlaps` afterwards.',
  })
  @ApiCreatedEnvelope(AreaDto, { isArray: true })
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  createMany(@Body() dto: BulkCreateAreasDto): Promise<AreaDto[]> {
    return this.areas.createMany(dto.cityId, dto.areas);
  }

  @Post('generate-grid')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Open a city — lay a gapless grid of cells over it',
    description:
      'The normal way to set a city up, and what rectangles buy: cells are ' +
      'generated from one arithmetic progression per axis, so they tile with ' +
      '**no gaps and no overlap by construction**. There is nothing to check ' +
      'for holes afterwards, because holes cannot exist.\n\n' +
      'Cells arrive named by grid position (`A1`, `B3`) — the generator has no ' +
      'idea what is on the ground. Then: rename the cells that matter, ' +
      'deactivate the ones in farmland or another district, set service ' +
      'availability, and only then turn the booking gate on.\n\n' +
      'Refuses to run on a city that already has areas.',
  })
  @ApiCreatedEnvelope(AreaDto, { isArray: true })
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  generateGrid(@Body() dto: GenerateGridDto): Promise<AreaDto[]> {
    return this.areas.generateGridForCity(dto);
  }

  @Get('service-matrix')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Every area in a city against every live service',
    description:
      'The grid that makes the map comprehensible. `isConfigured: false` ' +
      'means nobody has decided about that service there yet — different from ' +
      'someone deciding no, and identical to the customer either way.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  matrix(@Query('cityId') cityId: string) {
    return this.areas.serviceMatrixForCity(cityId);
  }

  @Post()
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Draw one rectangle by hand',
    description:
      'Bounds are **half-open**: `minLat <= lat < maxLat`. Butt it flush ' +
      'against its neighbours — sharing an edge exactly is correct and is ' +
      'what makes the map a clean partition. Overlapping is not an error but ' +
      'is a sign of a mistake; the resolver breaks it by smallest box.',
  })
  @ApiCreatedEnvelope(AreaDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  create(@Body() dto: CreateAreaDto): Promise<AreaDto> {
    return this.areas.create(dto);
  }

  @Get()
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({ summary: 'Areas in a city' })
  @ApiOkEnvelope(AreaDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(
    @Query('cityId') cityId: string,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<AreaDto[]> {
    return this.areas.listForCity(cityId, includeInactive === 'true');
  }

  @Patch(':id')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Rename, re-bound or deactivate an area',
    description:
      'The two everyday uses after generating a grid: **rename** a cell to ' +
      'what it actually is, and **deactivate** the ones that fall outside the ' +
      'city. Changing bounds breaks the tiling with the cell’s neighbours — ' +
      'check `/overlaps` after. Affects **future** resolutions only; bookings ' +
      'already taken keep the area they were sold into.',
  })
  @ApiOkEnvelope(AreaDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAreaDto,
  ): Promise<AreaDto> {
    return this.areas.update(id, dto);
  }

  @Get(':id/overlaps')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Which neighbours this area genuinely overlaps',
    description:
      '**Should be empty.** A generated grid tiles exactly, so anything here ' +
      'means a hand-edit broke the partition and two areas now claim the same ' +
      'ground. Resolution stays deterministic — smallest box wins — but this ' +
      'is a thing to look at, not the design working as intended. Touching ' +
      'edges are not overlap; adjacent cells share them by design.',
  })
  @ApiOkEnvelope(AreaOverlapDto, { isArray: true })
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  overlaps(@Param('id') id: string): Promise<AreaOverlapDto[]> {
    return this.areas.overlapsFor(id);
  }

  // ------------------------------------------------------------------
  // What is available where
  // ------------------------------------------------------------------

  @Get(':id/services')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({ summary: 'Services listed for this area' })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  services(@Param('id') id: string) {
    return this.areas.listServicesForArea(id);
  }

  @Post(':id/services')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Turn ONE service on or off in this area',
    description:
      'Availability only — price stays national. Idempotent: re-enabling a ' +
      'service switched off earlier is not an error. For a whole list, use ' +
      '`PUT` instead — it is one transaction rather than N calls.',
  })
  @ApiCreatedEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  setService(@Param('id') id: string, @Body() dto: SetAreaServiceDto) {
    return this.areas.setServiceAvailability(id, dto.serviceId, dto.isActive);
  }

  @Put(':id/services')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Replace this area’s entire service list',
    description:
      'Declarative: what you send ends up on, everything else ends up off, ' +
      'in one transaction. This is what an admin screen should call on save — ' +
      'a toggle per service means the screen has to diff its own state, and a ' +
      'failure halfway leaves the area in a state nobody intended.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  setServices(@Param('id') id: string, @Body() dto: SetAreaServicesDto) {
    return this.areas.setServicesForArea(id, dto.serviceIds);
  }

  @Post(':id/services/copy')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Copy another area’s availability onto this one',
    description:
      'The fastest way to set up a city. Neighbouring areas almost always ' +
      'offer the same catalogue, so the real workflow is "get one area right, ' +
      'then make the rest match" — one call per area instead of one per ' +
      'area per service.',
  })
  @ApiCreatedEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  copyServices(@Param('id') id: string, @Body() dto: CopyAreaServicesDto) {
    return this.areas.copyServicesBetweenAreas(dto.sourceAreaId, id);
  }

  @Post('by-service/:serviceId')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Turn one service on or off across many areas',
    description:
      'The other direction. "We now do AC repair everywhere in Indore" is a ' +
      'single decision, and making an admin open six area screens to express ' +
      'it is how areas drift out of sync with each other.',
  })
  @ApiCreatedEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  setAcrossAreas(
    @Param('serviceId') serviceId: string,
    @Body() dto: SetServiceAcrossAreasDto,
  ) {
    return this.areas.setServiceAcrossAreas(
      serviceId,
      dto.areaIds,
      dto.isActive,
    );
  }

  // ------------------------------------------------------------------
  // Who works where
  // ------------------------------------------------------------------

  @Post(':id/pros')
  @RequirePermissions(PermissionCode.PRO_AVAILABILITY_SET)
  @ApiOperation({
    summary: 'Post a Pro to this area, or take them off it',
    description:
      'Admin-set, like every other gate on a Pro — there is no self-service ' +
      'route for this, for the same reason there is no accept/decline. ' +
      'Posting is a **filter** on dispatch; distance still does the ranking.',
  })
  @ApiCreatedEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  setPro(@Param('id') id: string, @Body() dto: SetProAreaDto) {
    return this.areas.setProArea(dto.proId, id, dto.isActive);
  }

  @Get(':id/pros')
  @RequirePermissions(PermissionCode.PRO_AVAILABILITY_SET)
  @ApiOperation({ summary: 'Pros posted to this area' })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  prosForArea(@Param('id') id: string) {
    return this.areas.proIdsForArea(id);
  }
}
