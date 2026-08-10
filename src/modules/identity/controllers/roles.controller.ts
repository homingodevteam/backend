import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../../common/swagger/api-envelope.decorator';
import type { Role } from '../../../prisma/client';
import { PermissionCode } from '../constants/permission-code';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { CreateRoleDto } from '../dto/create-role.dto';
import { RoleDto } from '../dto/role.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import { RolesService } from '../services/roles.service';

@ApiTags('Admin — Roles')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @RequirePermissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({ summary: 'List all roles' })
  @ApiOkEnvelope(RoleDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN)
  findAll(): Promise<Role[]> {
    return this.rolesService.findAll();
  }

  @Post()
  @RequirePermissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({ summary: 'Create a role' })
  @ApiOkEnvelope(RoleDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.CONFLICT)
  create(@Body() dto: CreateRoleDto): Promise<Role> {
    return this.rolesService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({ summary: 'Update permissions for a fixed role' })
  @ApiOkEnvelope(RoleDto)
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto): Promise<Role> {
    return this.rolesService.update(id, dto);
  }
}
