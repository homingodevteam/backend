import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { ProService } from '../../prisma/client';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../identity/services/audit-log.service';
import { AssignServiceDto } from './dto/assign-service.dto';
import { UpdateProServiceDto } from './dto/update-pro-service.dto';

@Injectable()
export class ProServiceAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  list(proId: string): Promise<ProService[]> {
    return this.prisma.proService.findMany({ where: { proId } });
  }

  async assign(
    proId: string,
    dto: AssignServiceDto,
    adminUserId: string,
    ipAddress: string | null,
  ): Promise<ProService> {
    const existing = await this.prisma.proService.findUnique({
      where: { proId_serviceId: { proId, serviceId: dto.serviceId } },
    });
    if (existing) {
      throw apiError(
        'This Pro is already assigned to this service',
        HttpStatus.CONFLICT,
      );
    }

    const created = await this.prisma.proService.create({
      data: {
        proId,
        serviceId: dto.serviceId,
        proficiency: dto.proficiency ?? 'trainee',
        isActive: true,
      },
    });
    await this.auditLog.record({
      adminUserId,
      action: 'pro.service.assign',
      entityType: 'ProService',
      entityId: created.id,
      after: { ...created },
      ipAddress,
    });
    return created;
  }

  async update(
    proId: string,
    serviceId: string,
    dto: UpdateProServiceDto,
    adminUserId: string,
    ipAddress: string | null,
  ): Promise<ProService> {
    const proService = await this.prisma.proService.findUnique({
      where: { proId_serviceId: { proId, serviceId } },
    });
    if (!proService)
      throw new NotFoundException('Pro is not assigned to this service');

    const updated = await this.prisma.proService.update({
      where: { proId_serviceId: { proId, serviceId } },
      data: dto,
    });
    await this.auditLog.record({
      adminUserId,
      action: 'pro.service.update',
      entityType: 'ProService',
      entityId: proService.id,
      before: { ...proService },
      after: { ...updated },
      ipAddress,
    });
    return updated;
  }
}
