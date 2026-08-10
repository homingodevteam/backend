import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
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
import type { CustomerAddress } from '../../prisma/client';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CustomersService } from './customers.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { CustomerAddressDto } from './dto/customer-address.dto';
import { CustomerProfileDto } from './dto/customer-profile.dto';
import { ServiceabilityResponseDto } from './dto/serviceability-response.dto';
import { ReverseGeocodeQueryDto } from './dto/reverse-geocode-query.dto';
import { ReverseGeocodeResponseDto } from './dto/reverse-geocode-response.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@ApiTags('Customers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('customer')
@Controller('customers/me')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get('addresses/reverse-geocode')
  @ApiOperation({
    summary: 'Reverse geocode a map pin and resolve serviceability',
  })
  @ApiOkEnvelope(ReverseGeocodeResponseDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  reverseGeocode(
    @Query() query: ReverseGeocodeQueryDto,
  ): Promise<ReverseGeocodeResponseDto> {
    return this.customersService.reverseGeocode(query.pinLat, query.pinLng);
  }

  @Get()
  @ApiOperation({ summary: 'Get my profile' })
  @ApiOkEnvelope(CustomerProfileDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  getProfile(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerProfileDto> {
    return this.customersService.getProfile(user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Update my profile' })
  @ApiOkEnvelope(CustomerProfileDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCustomerDto,
  ): Promise<CustomerProfileDto> {
    return this.customersService.updateProfile(user.id, dto);
  }

  @Get('addresses')
  @ApiOperation({ summary: 'List my saved addresses' })
  @ApiOkEnvelope(CustomerAddressDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  listAddresses(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerAddress[]> {
    return this.customersService.listAddresses(user.id);
  }

  @Post('addresses')
  @ApiOperation({ summary: 'Add a saved address' })
  @ApiOkEnvelope(CustomerAddressDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  createAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAddressDto,
  ): Promise<CustomerAddress> {
    return this.customersService.createAddress(user.id, dto);
  }

  @Patch('addresses/:id')
  @ApiOperation({ summary: 'Update a saved address' })
  @ApiOkEnvelope(CustomerAddressDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  updateAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ): Promise<CustomerAddress> {
    return this.customersService.updateAddress(user.id, id, dto);
  }

  @Delete('addresses/:id')
  @ApiOperation({ summary: 'Delete a saved address' })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  deleteAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.customersService.deleteAddress(user.id, id);
  }

  @Patch('addresses/:id/default')
  @ApiOperation({ summary: 'Mark an address as the default' })
  @ApiOkEnvelope(CustomerAddressDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  setDefaultAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CustomerAddress> {
    return this.customersService.setDefaultAddress(user.id, id);
  }

  @Get('serviceability')
  @ApiOperation({ summary: 'Check whether a city is currently serviceable' })
  @ApiOkEnvelope(ServiceabilityResponseDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  checkServiceability(
    @Query('cityId') cityId: string,
  ): Promise<{ serviceable: boolean }> {
    return this.customersService.checkServiceability(cityId);
  }
}
