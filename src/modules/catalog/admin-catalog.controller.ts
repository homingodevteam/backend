import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { City, Service, ServiceCategory } from '../../prisma/client';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { AdminCatalogService } from './admin-catalog.service';
import { CatalogService } from './catalog.service';
import { AdminCatalogQueryDto } from './dto/admin-catalog-query.dto';
import { CityDto } from './dto/city.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateCityDto } from './dto/create-city.dto';
import { CreateServiceDto } from './dto/create-service.dto';
import { AdminServiceDto } from './dto/service.dto';
import { ServiceCategoryDto } from './dto/service-category.dto';
import { SetActivationDto } from './dto/set-activation.dto';
import { SetCityActivationDto } from './dto/set-city-activation.dto';
import { SetCommissionDto } from './dto/set-commission.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { UpdateCityDto } from './dto/update-city.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

/**
 * Catalog administration.
 *
 * Deliberately **not** city-scoped. The catalogue is national by ground rule —
 * one flat price, one commission rate, no per-city rows — so `CityScopeGuard`
 * has nothing to scope on and an Indore ops user editing a price does affect
 * Mumbai. That is a consequence of the pricing model, recorded in
 * CONFLICTS_AND_DECISIONS #8, not an oversight here.
 */
@ApiTags('Admin — Catalog')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(
    private readonly adminCatalog: AdminCatalogService,
    private readonly cities: CatalogService,
  ) {}

  // ----- Categories -----

  @Get('categories')
  @RequirePermissions(PermissionCode.CATALOG_MANAGE)
  @ApiOperation({ summary: 'List categories, including inactive ones' })
  @ApiOkEnvelope(ServiceCategoryDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listCategories(
    @Query() query: AdminCatalogQueryDto,
  ): Promise<ServiceCategory[]> {
    return this.adminCatalog.listCategories(query);
  }

  @Post('categories')
  @RequirePermissions(PermissionCode.CATALOG_MANAGE)
  @ApiOperation({ summary: 'Create a category' })
  @ApiCreatedEnvelope(ServiceCategoryDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  createCategory(@Body() dto: CreateCategoryDto): Promise<ServiceCategory> {
    return this.adminCatalog.createCategory(dto);
  }

  @Patch('categories/:id')
  @RequirePermissions(PermissionCode.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Update a category',
    description:
      '`slug` is immutable — deep links and the SDUI tree key off it.',
  })
  @ApiOkEnvelope(ServiceCategoryDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  updateCategory(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<ServiceCategory> {
    return this.adminCatalog.updateCategory(id, dto);
  }

  @Patch('categories/:id/activation')
  @RequirePermissions(PermissionCode.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Activate or deactivate a category',
    description:
      'Deactivating hides the whole subtree from browse without changing any ' +
      'child or service flag, so reactivating restores exactly what was there.',
  })
  @ApiOkEnvelope(ServiceCategoryDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  setCategoryActivation(
    @Param('id') id: string,
    @Body() dto: SetActivationDto,
  ): Promise<ServiceCategory> {
    return this.adminCatalog.setCategoryActivation(id, dto.isActive);
  }

  @Delete('categories/:id')
  @RequirePermissions(PermissionCode.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Delete an empty category',
    description:
      'Refused while any child category or service still references it — ' +
      'services must never be orphaned (US-3.8).',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  deleteCategory(@Param('id') id: string): Promise<void> {
    return this.adminCatalog.deleteCategory(id);
  }

  // ----- Services -----

  @Get('services')
  @RequirePermissions(PermissionCode.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'List services, including drafts and deactivated ones',
  })
  @ApiOkEnvelope(AdminServiceDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listServices(@Query() query: AdminCatalogQueryDto): Promise<Service[]> {
    return this.adminCatalog.listServices(query);
  }

  @Post('services')
  @RequirePermissions(PermissionCode.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Create a service',
    description:
      'Always created as a draft (`isActive: false`). Set a commission rate, ' +
      'then activate — a live service with no rate leaves Pros unpaid (US-3.11).',
  })
  @ApiCreatedEnvelope(AdminServiceDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  createService(@Body() dto: CreateServiceDto): Promise<Service> {
    return this.adminCatalog.createService(dto);
  }

  @Patch('services/:id')
  @RequirePermissions(PermissionCode.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Update a service',
    description:
      'Repricing never touches a booking already placed — module 4 snapshots ' +
      'price and duration at creation (US-3.5, US-3.6). Commission is a ' +
      'separate route with a separate permission.',
  })
  @ApiOkEnvelope(AdminServiceDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  updateService(
    @Param('id') id: string,
    @Body() dto: UpdateServiceDto,
  ): Promise<Service> {
    return this.adminCatalog.updateService(id, dto);
  }

  @Patch('services/:id/commission')
  @RequirePermissions(PermissionCode.CATALOG_COMMISSION_SET)
  @ApiOperation({
    summary: 'Set the commission rate for a service',
    description:
      'Finance-owned, separate from repricing. Applies to future completions ' +
      'only — past BookingCommission rows hold their own snapshot (US-3.10).',
  })
  @ApiOkEnvelope(AdminServiceDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  setCommission(
    @Param('id') id: string,
    @Body() dto: SetCommissionDto,
  ): Promise<Service> {
    return this.adminCatalog.setCommission(id, dto);
  }

  @Patch('services/:id/activation')
  @RequirePermissions(PermissionCode.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Activate or deactivate a service',
    description:
      'Activation requires a commission rate, an active category and at least ' +
      'one booking type. Deactivation is unconditional and never cancels work ' +
      'already sold (US-3.7).',
  })
  @ApiOkEnvelope(AdminServiceDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  setServiceActivation(
    @Param('id') id: string,
    @Body() dto: SetActivationDto,
  ): Promise<Service> {
    return this.adminCatalog.setServiceActivation(id, dto.isActive);
  }

  // ----- Cities -----

  @Get('cities')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({ summary: 'List cities, including unlaunched ones' })
  @ApiOkEnvelope(CityDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listCities(): Promise<City[]> {
    return this.cities.findAll();
  }

  @Post('cities')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Add a city to the registry',
    description: 'Created dark unless `isActive` is explicitly true.',
  })
  @ApiCreatedEnvelope(CityDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
  )
  createCity(@Body() dto: CreateCityDto): Promise<City> {
    return this.cities.create(dto);
  }

  @Patch('cities/:id')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({ summary: 'Update a city' })
  @ApiOkEnvelope(CityDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  updateCity(
    @Param('id') id: string,
    @Body() dto: UpdateCityDto,
  ): Promise<City> {
    return this.cities.update(id, dto);
  }

  @Patch('cities/:id/activation')
  @RequirePermissions(PermissionCode.CATALOG_CITY_MANAGE)
  @ApiOperation({
    summary: 'Launch or pause a city',
    description:
      'The whole of serviceability: module 2 answers "can I book here?" from ' +
      'this flag alone. Launching is refused with a 409 when no approved Pro ' +
      'is based in the city (US-3.9) — pass `acknowledgeNoSupply` to override.',
  })
  @ApiOkEnvelope(CityDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  setCityActivation(
    @Param('id') id: string,
    @Body() dto: SetCityActivationDto,
  ): Promise<City> {
    return this.cities.setActivation(
      id,
      dto.isActive,
      dto.acknowledgeNoSupply ?? false,
    );
  }
}
