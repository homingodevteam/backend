import { HttpStatus, Injectable } from '@nestjs/common';
import type { Role } from '../../../prisma/client';
import { apiError } from '../../../common/utils';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateRoleDto } from '../dto/create-role.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';
import { AuditLogService } from './audit-log.service';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  findAll(): Promise<Role[]> {
    return this.prisma.role.findMany({ orderBy: { name: 'asc' } });
  }

  async create(
    dto: CreateRoleDto,
    adminUserId: string,
    ipAddress: string | null,
  ): Promise<Role> {
    const existing = await this.prisma.role.findUnique({
      where: { name: dto.name },
    });
    if (existing) {
      throw apiError(`Role "${dto.name}" already exists`, HttpStatus.CONFLICT);
    }

    const role = await this.prisma.role.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        permissionCodes: dto.permissionCodes,
        isSystemRole: true,
      },
    });
    await this.auditLog.record({
      adminUserId,
      action: 'identity.role.create',
      entityType: 'Role',
      entityId: role.id,
      after: { ...role },
      ipAddress,
    });
    return role;
  }

  async update(
    id: string,
    dto: UpdateRoleDto,
    adminUserId: string,
    ipAddress: string | null,
  ): Promise<Role> {
    const before = await this.prisma.role.findUnique({ where: { id } });
    if (!before) throw apiError('Role not found', HttpStatus.NOT_FOUND);
    const role = await this.prisma.role.update({ where: { id }, data: dto });
    await this.auditLog.record({
      adminUserId,
      action: 'identity.role.update',
      entityType: 'Role',
      entityId: id,
      before: { ...before },
      after: { ...role },
      ipAddress,
    });
    return role;
  }
}
