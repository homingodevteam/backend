import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminUser } from '../../../prisma/client';
import { apiError } from '../../../common/utils';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateAdminUserDto } from '../dto/create-admin-user.dto';
import { UpdateAdminUserDto } from '../dto/update-admin-user.dto';
import { AuditLogService } from './audit-log.service';

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  findAll(): Promise<AdminUser[]> {
    return this.prisma.adminUser.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(
    dto: CreateAdminUserDto,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<AdminUser> {
    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role) throw apiError('roleId does not exist', HttpStatus.BAD_REQUEST);

    const existing = await this.prisma.adminUser.findUnique({
      where: { phone: dto.phone },
    });
    if (existing) {
      throw apiError(
        'An admin with this phone already exists',
        HttpStatus.CONFLICT,
      );
    }

    const created = await this.prisma.adminUser.create({
      data: {
        phone: dto.phone,
        fullName: dto.fullName,
        email: dto.email ?? null,
        roleId: dto.roleId,
        cityScopeJson: dto.cityScopeJson ?? [],
      },
    });

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: 'identity.adminUser.create',
      entityType: 'AdminUser',
      entityId: created.id,
      after: { ...created },
      ipAddress,
    });

    return created;
  }

  async update(
    id: string,
    dto: UpdateAdminUserDto,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<AdminUser> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) throw new NotFoundException('Admin user not found');

    if (dto.roleId) {
      const role = await this.prisma.role.findUnique({
        where: { id: dto.roleId },
      });
      if (!role)
        throw apiError('roleId does not exist', HttpStatus.BAD_REQUEST);
    }

    const updated = await this.prisma.adminUser.update({
      where: { id },
      data: {
        fullName: dto.fullName,
        email: dto.email,
        roleId: dto.roleId,
        cityScopeJson: dto.cityScopeJson,
        isActive: dto.isActive,
      },
    });

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: 'identity.adminUser.update',
      entityType: 'AdminUser',
      entityId: updated.id,
      before: { ...admin },
      after: { ...updated },
      ipAddress,
    });

    return updated;
  }
}
