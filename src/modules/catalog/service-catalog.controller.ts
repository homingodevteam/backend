import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { CategoryTreeNode } from './catalog.types';
import { BrowseServicesQueryDto } from './dto/browse-services-query.dto';
import { CategoryTreeNodeDto } from './dto/service-category.dto';
import { ServiceDto } from './dto/service.dto';
import {
  ServiceCatalogService,
  type PublicService,
} from './service-catalog.service';

/**
 * Browse and search, for the customer app.
 *
 * Unauthenticated on purpose: the catalogue is what a first-time user sees
 * before they have a session at all, and module 1's guest flow exists so the
 * browse-then-sign-in order works. Nothing here exposes commission — the
 * platform/Pro split never appears on a customer surface (US-3.2).
 */
@ApiTags('Catalog')
@Controller('catalog')
export class ServiceCatalogController {
  constructor(private readonly catalog: ServiceCatalogService) {}

  @Get('categories')
  @ApiOperation({
    summary: 'Browse the category tree',
    description:
      'Active categories, two levels deep, each with its active services. ' +
      'Ordered by sortOrder then name.',
  })
  @ApiOkEnvelope(CategoryTreeNodeDto, { isArray: true })
  getCategoryTree(): Promise<CategoryTreeNode[]> {
    return this.catalog.getCategoryTree();
  }

  @Get('categories/:id/services')
  @ApiOperation({ summary: 'List the active services in one category' })
  @ApiOkEnvelope(ServiceDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.NOT_FOUND)
  listServicesInCategory(@Param('id') id: string): Promise<PublicService[]> {
    return this.catalog.listServicesInCategory(id);
  }

  @Get('services')
  @ApiOperation({
    summary: 'Search and filter bookable services',
    description:
      'Active services under active categories. `q` is a case-insensitive ' +
      'substring match on name and description.',
  })
  @ApiOkEnvelope(ServiceDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.BAD_REQUEST)
  listServices(
    @Query() query: BrowseServicesQueryDto,
  ): Promise<PublicService[]> {
    return this.catalog.listServices(query);
  }

  @Get('services/:id')
  @ApiOperation({
    summary: 'Get one service by id',
    description:
      'Resolves inactive services too, so a past booking can still render ' +
      'the name and price of what was bought (US-3.1).',
  })
  @ApiOkEnvelope(ServiceDto)
  @ApiErrorEnvelope(HttpStatus.NOT_FOUND)
  getService(@Param('id') id: string): Promise<PublicService> {
    return this.catalog.getPublicServiceOrFail(id);
  }
}
