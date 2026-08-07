import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import { AuditLogService } from '../identity/services/audit-log.service';
import { RequestKycUploadUrlDto } from './dto/request-kyc-upload-url.dto';

/**
 * Thin wrapper over S3Service that fixes the key prefix and — for reads —
 * enforces the "every view is audit-logged" rule from the KYC security
 * notes. The client PUTs the file directly to S3 with the URL this
 * returns; the platform never sees the bytes.
 */
@Injectable()
export class KycDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly auditLog: AuditLogService,
  ) {}

  requestUploadUrl(
    proId: string,
    dto: RequestKycUploadUrlDto,
  ): Promise<{ key: string; uploadUrl: string; expiresIn: number }> {
    return this.s3.createUploadUrl(
      `kyc/${proId}/${dto.docType}`,
      dto.contentType,
    );
  }

  async requestViewUrl(
    applicationId: string,
    docType: string,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<{ viewUrl: string; expiresIn: number }> {
    if (docType !== 'aadhaar' && docType !== 'pan') {
      throw apiError(
        'docType must be "aadhaar" or "pan"',
        HttpStatus.BAD_REQUEST,
      );
    }

    const application = await this.prisma.proApplication.findUnique({
      where: { id: applicationId },
    });
    if (!application) throw new NotFoundException('Application not found');

    const key =
      docType === 'aadhaar' ? application.aadhaarUrl : application.panUrl;
    if (!key) {
      throw apiError(
        `No ${docType} document on this application`,
        HttpStatus.NOT_FOUND,
      );
    }

    const result = await this.s3.createViewUrl(key);

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: `pro.application.${docType}.view`,
      entityType: 'ProApplication',
      entityId: applicationId,
      ipAddress,
    });

    return result;
  }
}
