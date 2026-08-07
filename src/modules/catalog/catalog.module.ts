import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/**
 * Placeholder for the real Service Catalog module (module 3). Exists only
 * so CustomerAddress and Pro have a City to point their cityId FK at.
 */
@Module({
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
