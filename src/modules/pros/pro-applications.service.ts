import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { ProApplication } from '../../prisma/client';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../identity/services/audit-log.service';
import { ApplicationDecisionDto } from './dto/application-decision.dto';
import { SubmitProApplicationDto } from './dto/submit-pro-application.dto';
import { VerifyDocumentDto } from './dto/verify-document.dto';
import { ProsService } from './pros.service';

@Injectable()
export class ProApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prosService: ProsService,
    private readonly auditLog: AuditLogService,
  ) {}

  listForPro(proId: string): Promise<ProApplication[]> {
    return this.prisma.proApplication.findMany({
      where: { proId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async submit(
    proId: string,
    dto: SubmitProApplicationDto,
  ): Promise<ProApplication> {
    this.prosService.assertDigilockerNotSupported(dto.aadhaarSource);
    this.prosService.assertDigilockerNotSupported(dto.panSource);

    if (dto.aadhaarSource === 'manual' && !dto.aadhaarUrl) {
      throw apiError(
        'aadhaarUrl is required for a manual submission',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dto.panSource === 'manual' && !dto.panUrl) {
      throw apiError(
        'panUrl is required for a manual submission',
        HttpStatus.BAD_REQUEST,
      );
    }

    const application = await this.prisma.proApplication.create({
      data: {
        proId,
        referredByType: dto.referredByType ?? 'none',
        referredById: dto.referredById ?? null,
        submittedAt: new Date(),
        queueStatus: 'pending',
        aadhaarSource: dto.aadhaarSource,
        aadhaarUrl: dto.aadhaarUrl ?? null,
        aadhaarNumberMasked: dto.aadhaarNumberMasked ?? null,
        panSource: dto.panSource,
        panUrl: dto.panUrl ?? null,
        panNumberMasked: dto.panNumberMasked ?? null,
      },
    });

    // A fresh or re-application both mean "back under review".
    await this.prisma.pro.update({
      where: { id: proId },
      data: { status: 'under_review' },
    });

    return application;
  }

  findAll(filters: { queueStatus?: string }): Promise<ProApplication[]> {
    return this.prisma.proApplication.findMany({
      where: filters.queueStatus ? { queueStatus: filters.queueStatus } : {},
      orderBy: { submittedAt: 'asc' },
    });
  }

  private async getOrThrow(id: string): Promise<ProApplication> {
    const application = await this.prisma.proApplication.findUnique({
      where: { id },
    });
    if (!application) throw new NotFoundException('Application not found');
    return application;
  }

  async verifyDocument(
    id: string,
    dto: VerifyDocumentDto,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<ProApplication> {
    const application = await this.getOrThrow(id);

    if (dto.decision === 'rejected' && !dto.reason) {
      throw apiError(
        'reason is required when rejecting a document',
        HttpStatus.BAD_REQUEST,
      );
    }

    const before =
      dto.docType === 'aadhaar'
        ? { aadhaarStatus: application.aadhaarStatus }
        : { panStatus: application.panStatus };

    const updated = await this.prisma.proApplication.update({
      where: { id },
      data:
        dto.docType === 'aadhaar'
          ? {
              aadhaarStatus: dto.decision,
              aadhaarVerifiedByAdminId: actingAdminId,
              aadhaarVerifiedAt: new Date(),
              aadhaarRejectionReason:
                dto.decision === 'rejected' ? (dto.reason ?? null) : null,
              queueStatus:
                application.queueStatus === 'pending'
                  ? 'docs_review'
                  : application.queueStatus,
            }
          : {
              panStatus: dto.decision,
              panVerifiedByAdminId: actingAdminId,
              panVerifiedAt: new Date(),
              panRejectionReason:
                dto.decision === 'rejected' ? (dto.reason ?? null) : null,
              queueStatus:
                application.queueStatus === 'pending'
                  ? 'docs_review'
                  : application.queueStatus,
            },
    });

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: `pro.application.${dto.docType}.${dto.decision}`,
      entityType: 'ProApplication',
      entityId: id,
      before,
      after:
        dto.docType === 'aadhaar'
          ? { aadhaarStatus: updated.aadhaarStatus }
          : { panStatus: updated.panStatus },
      ipAddress,
    });

    return updated;
  }

  async logCall(id: string, actingAdminId: string): Promise<ProApplication> {
    const application = await this.getOrThrow(id);
    const nextQueueStatus =
      application.queueStatus !== 'approved' &&
      application.queueStatus !== 'rejected'
        ? 'call_pending'
        : application.queueStatus;

    return this.prisma.proApplication.update({
      where: { id },
      data: {
        verificationCallAt: new Date(),
        reviewedByAdminId: actingAdminId,
        queueStatus: nextQueueStatus,
      },
    });
  }

  async decide(
    id: string,
    dto: ApplicationDecisionDto,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<ProApplication> {
    const application = await this.getOrThrow(id);

    if (dto.decision === 'approved') {
      if (
        application.aadhaarStatus !== 'verified' ||
        application.panStatus !== 'verified'
      ) {
        throw apiError(
          'Both Aadhaar and PAN must be verified before approval',
          HttpStatus.CONFLICT,
        );
      }
    } else if (!dto.reason) {
      throw apiError(
        'reason is required when rejecting an application',
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.proApplication.update({
      where: { id },
      data: {
        decision: dto.decision,
        decisionAt: new Date(),
        rejectionReason:
          dto.decision === 'rejected' ? (dto.reason ?? null) : null,
        queueStatus: dto.decision,
        reviewedByAdminId: actingAdminId,
      },
    });

    const pro = await this.prisma.pro.findUnique({
      where: { id: application.proId },
    });
    if (pro) {
      if (dto.decision === 'approved') {
        const employeeCode =
          pro.employeeCode ?? (await this.prosService.generateEmployeeCode());
        await this.prisma.pro.update({
          where: { id: pro.id },
          data: {
            status: 'approved',
            approvedApplicationId: application.id,
            approvedAt: new Date(),
            employeeCode,
          },
        });
      } else {
        await this.prisma.pro.update({
          where: { id: pro.id },
          data: { status: 'rejected' },
        });
      }
    }

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: `pro.application.${dto.decision}`,
      entityType: 'ProApplication',
      entityId: id,
      after: { decision: updated.decision },
      ipAddress,
    });

    return updated;
  }
}
