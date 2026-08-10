import { HttpStatus, Injectable } from '@nestjs/common';
import type { Role } from '../../../prisma/client';
import { apiError } from '../../../common/utils';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateRoleDto } from '../dto/create-role.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Role[]> {
    return this.prisma.role.findMany({ orderBy: { name: 'asc' } });
  }

  async create(dto: CreateRoleDto): Promise<Role> {
    const existing = await this.prisma.role.findUnique({
      where: { name: dto.name },
    });
    if (existing) {
      throw apiError(`Role "${dto.name}" already exists`, HttpStatus.CONFLICT);
    }

    return this.prisma.role.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        permissionCodes: dto.permissionCodes,
        isSystemRole: true,
      },
    });
  }

  async update(id: string, dto: UpdateRoleDto): Promise<Role> {
    const existing = await this.prisma.role.findUnique({ where: { id } });
    if (!existing) throw apiError('Role not found', HttpStatus.NOT_FOUND);
    return this.prisma.role.update({ where: { id }, data: dto });
  }
}
