import {
  Controller,
  HttpStatus,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { Customer } from '../../prisma/client';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { CityScopedResource } from '../identity/decorators/city-scoped-resource.decorator';
import { CityScopeGuard } from '../identity/guards/city-scope.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { CustomersService } from './customers.service';
import { CustomerDto } from './dto/customer.dto';

@ApiTags('Admin — Customers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard, CityScopeGuard)
@RequirePermissions(PermissionCode.CUSTOMER_MODERATE)
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Patch(':id/block')
  @CityScopedResource('customer')
  @ApiOperation({ summary: 'Block a customer' })
  @ApiOkEnvelope(CustomerDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  block(@Param('id') id: string): Promise<Customer> {
    return this.customersService.block(id);
  }

  @Patch(':id/unblock')
  @CityScopedResource('customer')
  @ApiOperation({ summary: 'Unblock a customer' })
  @ApiOkEnvelope(CustomerDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  unblock(@Param('id') id: string): Promise<Customer> {
    return this.customersService.unblock(id);
  }
}
