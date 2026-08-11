import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import type { Customer } from '../../prisma/client';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { CityScopedResource } from '../identity/decorators/city-scoped-resource.decorator';
import { CityScopeGuard } from '../identity/guards/city-scope.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { CustomersService } from './customers.service';
import { AdminCustomerQueryDto } from './dto/admin-customer-query.dto';
import { CustomerDto } from './dto/customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@ApiTags('Admin — Customers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard, CityScopeGuard)
@RequirePermissions(PermissionCode.CUSTOMER_MODERATE)
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @ApiOperation({
    summary: 'List customers',
    description:
      'Newest first, capped at 100 rather than paginated. Filter by phone, ' +
      'email or name (`search`), status or block state; omit everything to ' +
      'see everything recent.\n\n' +
      'City-scoped the same way ProsService.findMany is: a customer counts ' +
      'as in-scope if they have at least one saved address in one of the ' +
      "admin's allowed cities. This is done in the service (query.where), " +
      'not by CityScopeGuard — that guard only knows how to scope a single ' +
      "resource by id, not a list query, so it can't be relied on here.",
  })
  @ApiOkEnvelope(CustomerDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(
    @Query() query: AdminCustomerQueryDto,
    @CurrentUser() actor?: AuthenticatedUser,
  ): Promise<Customer[]> {
    return this.customersService.listForAdmin(query, actor?.cityScope);
  }

  @Get(':id')
  @CityScopedResource('customer')
  @ApiOperation({
    summary: 'Customer 360',
    description:
      'Profile, every saved address and the 20 most recent bookings in one ' +
      'call — orders/refunds/tickets/notifications will join this once those ' +
      'modules exist (US-15.4).',
  })
  @ApiOkEnvelope(CustomerDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  getOne(@Param('id') id: string) {
    return this.customersService.getAdminDetail(id);
  }

  @Patch(':id')
  @CityScopedResource('customer')
  @ApiOperation({
    summary: "Correct a customer's name or email",
    description:
      'Support-side correction (e.g. a misspelled name) — not a general ' +
      'profile editor. Email is invoice delivery only, never a login ' +
      'credential, so changing it does not affect how the customer signs in.',
  })
  @ApiOkEnvelope(CustomerDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customersService.updateProfile(id, dto);
  }

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
