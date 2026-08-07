import { Module } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module';
import { S3Module } from '../../storage/s3.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminProsController } from './admin-pros.controller';
import { KycDocumentsService } from './kyc-documents.service';
import { ProApplicationsService } from './pro-applications.service';
import { ProBankAccountsService } from './pro-bank-accounts.service';
import { ProServiceAssignmentsService } from './pro-service-assignments.service';
import { ProsController } from './pros.controller';
import { ProsService } from './pros.service';

@Module({
  imports: [IdentityModule, S3Module, RedisModule],
  controllers: [ProsController, AdminProsController],
  providers: [
    ProsService,
    ProApplicationsService,
    ProBankAccountsService,
    ProServiceAssignmentsService,
    KycDocumentsService,
  ],
})
export class ProsModule {}
