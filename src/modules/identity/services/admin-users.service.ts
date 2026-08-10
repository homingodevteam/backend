import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminUser } from '../../../prisma/client';
import { apiError } from '../../../common/utils';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateAdminUserDto } from '../dto/create-admin-user.dto';
import { UpdateAdminUserDto } from '../dto/update-admin-user.dto';
import { TokenService } from './token.service';

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  findAll(): Promise<AdminUser[]> {
    return this.prisma.adminUser.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(dto: CreateAdminUserDto): Promise<AdminUser> {
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

    return this.prisma.adminUser.create({
      data: {
        phone: dto.phone,
        fullName: dto.fullName,
        email: dto.email ?? null,
        roleId: dto.roleId,
        cityScopeJson: dto.cityScopeJson ?? [],
      },
    });
  }

  async update(id: string, dto: UpdateAdminUserDto): Promise<AdminUser> {
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

    if (dto.isActive === false) {
      await this.tokenService.revokeAllSessions('admin', id);
    }

    return updated;
  }
}
