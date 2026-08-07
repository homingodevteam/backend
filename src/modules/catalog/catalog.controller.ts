import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiOkEnvelope } from '../../common/swagger/api-envelope.decorator';
import type { City } from '../../prisma/client';
import { CatalogService } from './catalog.service';
import { CityDto } from './dto/city.dto';

@ApiTags('Catalog')
@Controller('cities')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'List active cities' })
  @ApiOkEnvelope(CityDto, { isArray: true })
  findActive(): Promise<City[]> {
    return this.catalogService.findActiveCities();
  }
}
