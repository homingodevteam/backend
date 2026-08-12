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
import { AreaNamingService } from './area-naming.service';
import { AreasService } from './areas.service';
import {
  AreaDto,
  AreaOverlapDto,
  BulkCreateAreasDto,
  CopyAreaServicesDto,
  CityBoundsDto,
  CityBoundsQueryDto,
  CreateAreaDto,
  DeactivateOutsideDto,
  DeactivateOutsideResultDto,
  GenerateGridDto,
  GenerateGridForBoxDto,
  PreviewGridDto,
  PreviewGridResultDto,
  RegenerateGridDto,
  RegenerateResultDto,
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
  constructor(
    private readonly areas: AreasService,
    private readonly naming: AreaNamingService,
  ) {}

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
  async createMany(@Body() dto: BulkCreateAreasDto): Promise<AreaDto[]> {
    const created = await this.areas.createMany(dto.cityId, dto.areas);
    return created.map((area) => this.areas.describe(area));
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
  async generateGrid(@Body() dto: GenerateGridDto): Promise<AreaDto[]> {
    const cells = await this.areas.generateGridForCity(dto);
    return cells.map((cell) => this.areas.describe(cell));
  }

  @Get('city-bounds')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'How big is this city, actually?',
    description:
      'Asks the geocoder for a named place and returns the rectangle it ' +
      'occupies. Read-only — nothing is created.\n\n' +
      'Run this **before** generating anything. Google puts Indore at about ' +
      '24.6 x 20.1 km, which at 1 km cells is roughly 500 rows; guessing a ' +
      '30 km square instead covers half again as much farmland. Pass ' +
      '`cellSizeKm` to be told the count up front.\n\n' +
      'A rectangle, not a radius, because cities are not square — and the ' +
      'difference is a fifth of the cells for a city like Indore.',
  })
  @ApiOkEnvelope(CityBoundsDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  async cityBounds(@Query() query: CityBoundsQueryDto): Promise<CityBoundsDto> {
    const bounds = await this.areas.cityBounds(query.name);
    return {
      ...bounds,
      cellCount: query.cellSizeKm
        ? this.areas.countCellsFor(bounds, query.cellSizeKm)
        : null,
    };
  }

  @Post('preview-grid')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'See a grid before creating it',
    description:
      'Returns exactly the cells `generate-grid-for-box` would create, with ' +
      'the names the naming pass would suggest — and **writes nothing**.\n\n' +
      'Opening a city used to be a one-way door: pick a size, create five ' +
      'hundred rows, then discover they are too coarse. Try 2 km, look, try ' +
      '1 km, look, and commit when it reads right.\n\n' +
      'Naming is **sampled**: `nameLimit` cells (default 25, max 100) get real ' +
      'names and the rest return their grid reference. A 525-cell grid is 525 ' +
      'geocoder calls, which is not a request that can be held open — and the ' +
      'sample is enough to judge whether the size is right, which is the only ' +
      'question a preview has to answer. Pass `0` to spend nothing.',
  })
  @ApiOkEnvelope(PreviewGridResultDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
  )
  previewGrid(@Body() dto: PreviewGridDto): Promise<PreviewGridResultDto> {
    return this.areas.previewGrid({
      cellSizeKm: dto.cellSizeKm,
      nameLimit: dto.nameLimit,
      box: {
        minLat: dto.minLat,
        maxLat: dto.maxLat,
        minLng: dto.minLng,
        maxLng: dto.maxLng,
      },
    });
  }

  @Post('generate-grid-for-box')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Lay a grid over a rectangle',
    description:
      'The same gapless tiling as `generate-grid`, from a box instead of a ' +
      'centre and a half-width. Pair it with `GET /admin/areas/city-bounds` ' +
      'and the box is the city rather than a square guessed around it.\n\n' +
      'Cells arrive named by grid position (`A1`, `B3`). Then: ' +
      '`POST /admin/areas/deactivate-outside` to drop the farmland, ' +
      '`POST /admin/areas/suggest-names` to name what is left, and only then ' +
      'the booking gate.\n\n' +
      'Refuses to run on a city that already has areas — use `regenerate`.',
  })
  @ApiCreatedEnvelope(AreaDto, { isArray: true })
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async generateGridForBox(
    @Body() dto: GenerateGridForBoxDto,
  ): Promise<AreaDto[]> {
    const cells = await this.areas.generateGridForBox({
      cityId: dto.cityId,
      cellSizeKm: dto.cellSizeKm,
      box: {
        minLat: dto.minLat,
        maxLat: dto.maxLat,
        minLng: dto.minLng,
        maxLng: dto.maxLng,
      },
    });
    return cells.map((cell) => this.areas.describe(cell));
  }

  @Post('deactivate-outside')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Drop every cell outside a boundary, in one call',
    description:
      'The bulk half of opening a city. A 20 x 25 km city at 1 km cells is ' +
      '~500 rows and most of them are farmland — deactivating those one ' +
      '`PATCH` at a time is not a workflow anybody finishes, and a ' +
      'half-pruned map is worse than an unpruned one because the leftovers ' +
      'are invisible until somebody books from a field.\n\n' +
      '**Run it with `dryRun: true` first.** It returns what it would touch ' +
      'and changes nothing.\n\n' +
      'A cell is judged by its **centre**. One straddling the boundary is ' +
      'kept — erring inward would leave a hole at the city edge, which ' +
      'surfaces as "we do not serve your street" to somebody who lives in ' +
      'town.\n\n' +
      'Deactivates, never deletes: a booking may point at the cell, and it is ' +
      'the record of where that work was sold.',
  })
  @ApiOkEnvelope(DeactivateOutsideResultDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async deactivateOutside(
    @Body() dto: DeactivateOutsideDto,
  ): Promise<DeactivateOutsideResultDto> {
    return this.areas.deactivateOutside({
      cityId: dto.cityId,
      dryRun: dto.dryRun,
      box: {
        minLat: dto.minLat,
        maxLat: dto.maxLat,
        minLng: dto.minLng,
        maxLng: dto.maxLng,
      },
    });
  }

  @Post('regenerate')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Replace a city map — the supported way to change cell size',
    description:
      'Without this, `generate-grid` refuses on an already-mapped city and ' +
      'there is no way back: "I generated at 6 km and actually want 1 km" ' +
      'ends with somebody editing rows by hand.\n\n' +
      'Old cells are handled by whether anything depends on them. **Never ' +
      'booked** — deleted, freeing their names. **Booked at least once** — ' +
      'deactivated and renamed with a `(retired ...)` suffix, so the booking ' +
      'still points at a row that says where the work was sold.\n\n' +
      'Destructive and not reversible. Take the `dryRun` on ' +
      '`deactivate-outside` as the model: check `GET /admin/areas` first and ' +
      'know what you are replacing.',
  })
  @ApiCreatedEnvelope(RegenerateResultDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async regenerate(
    @Body() dto: RegenerateGridDto,
  ): Promise<RegenerateResultDto> {
    const result = await this.areas.regenerate({
      cityId: dto.cityId,
      cellSizeKm: dto.cellSizeKm,
      box: {
        minLat: dto.minLat,
        maxLat: dto.maxLat,
        minLng: dto.minLng,
        maxLng: dto.maxLng,
      },
    });
    return {
      retired: result.retired,
      deleted: result.deleted,
      created: result.created.map((cell) => this.areas.describe(cell)),
    };
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
  async create(@Body() dto: CreateAreaDto): Promise<AreaDto> {
    return this.areas.describe(await this.areas.create(dto));
  }

  @Get()
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Areas in a city, each ready to be recognised',
    description:
      'Every row carries its centre, its size in kilometres and a **Google ' +
      'Maps link** — four raw coordinates tell a human nothing, one click ' +
      'tells them everything. `nameSource` says whether the name is still a ' +
      'generated placeholder (`A1`), a geocoded suggestion awaiting review, ' +
      'or something a person chose.',
  })
  @ApiOkEnvelope(AreaDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(
    @Query('cityId') cityId: string,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<AreaDto[]> {
    return this.areas.describeForCity(cityId, includeInactive === 'true');
  }

  @Post('suggest-names')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Suggest a real name for every unnamed grid cell',
    description:
      'Reverse-geocodes the centre of each cell still called `A1` and ' +
      'pre-fills a suggestion, turning "identify thirty-six mystery squares" ' +
      'into "review thirty-six pre-filled names".\n\n' +
      '**Returns immediately and keeps working.** The geocoder honours ' +
      "Nominatim's one-request-per-second policy, so a 36-cell grid takes " +
      'over half a minute — too long to hold a request open. Poll ' +
      '`GET /admin/areas/naming-progress`, or re-read the area list and watch ' +
      'the names fill in.\n\n' +
      '**Never overwrites a name a person chose.** Only cells whose ' +
      '`nameSource` is still `generated` are touched, so this is safe to ' +
      're-run and safe to run while someone is renaming.',
  })
  @ApiCreatedEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
  )
  suggestNames(@Query('cityId') cityId: string) {
    return this.naming.start(cityId);
  }

  @Get('naming-progress')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'How far the naming pass has got',
    description:
      '`pending` counts cells still carrying a generated placeholder — the ' +
      'worklist. `suggested` counts geocoded names awaiting review.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  namingProgress(@Query('cityId') cityId: string) {
    return this.naming.progressFor(cityId);
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
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAreaDto,
  ): Promise<AreaDto> {
    return this.areas.describe(await this.areas.update(id, dto));
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
