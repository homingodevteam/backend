import { Module, forwardRef } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module';
import { S3Module } from '../../storage/s3.module';
import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminProsController } from './admin-pros.controller';
import { KycDocumentsService } from './kyc-documents.service';
import { ProApplicationsService } from './pro-applications.service';
import { ProBankAccountsService } from './pro-bank-accounts.service';
import { ProServiceAssignmentsService } from './pro-service-assignments.service';
import { ProsController } from './pros.controller';
import { ProsService } from './pros.service';
import { ProCountersService } from './pro-counters.service';
import { ProStandingService } from './pro-standing.service';
import { ProProfilePhotoService } from './pro-profile-photo.service';

@Module({
  // CatalogModule: a Pro can only be assigned a service that exists in the
  // catalogue, and the check goes through the catalog's own service rather
  // than reaching into its tables.
  //
  // The relationship is genuinely bidirectional — Catalog needs Pro supply
  // counts to gate a city launch (US-3.9) — so both sides use forwardRef.
  imports: [
    IdentityModule,
    S3Module,
    RedisModule,
    forwardRef(() => CatalogModule),
  ],
  controllers: [ProsController, AdminProsController],
  providers: [
    ProsService,
    ProApplicationsService,
    ProBankAccountsService,
    ProServiceAssignmentsService,
    KycDocumentsService,
    ProCountersService,
    ProStandingService,
    ProProfilePhotoService,
  ],
  exports: [ProCountersService, ProsService],
})
export class ProsModule {}
