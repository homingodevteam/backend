import {
  Controller,
  HttpStatus,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import type { Customer } from '../../prisma/client';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { CustomersService } from './customers.service';
import { CustomerDto } from './dto/customer.dto';

@ApiTags('Admin — Customers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PermissionCode.CUSTOMER_MODERATE)
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Patch(':id/block')
  @ApiOperation({ summary: 'Block a customer' })
  @ApiOkEnvelope(CustomerDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  block(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<Customer> {
    return this.customersService.block(id, actor.id, request.ip ?? null);
  }

  @Patch(':id/unblock')
  @ApiOperation({ summary: 'Unblock a customer' })
  @ApiOkEnvelope(CustomerDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  unblock(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<Customer> {
    return this.customersService.unblock(id, actor.id, request.ip ?? null);
  }
}
