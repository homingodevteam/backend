import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Customer, CustomerAddress, Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../identity/services/token.service';
import { AddressLocationService } from './address-location.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { CustomerProfileDto } from './dto/customer-profile.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly addressLocation: AddressLocationService,
  ) {}

  async getById(id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async getProfile(id: string): Promise<CustomerProfileDto> {
    return this.toProfile(await this.getById(id));
  }

  async updateProfile(
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerProfileDto> {
    await this.getById(id);
    const updated = await this.prisma.customer.update({
      where: { id },
      data: dto,
    });
    return this.toProfile(updated);
  }

  listAddresses(customerId: string): Promise<CustomerAddress[]> {
    return this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  reverseGeocode(pinLat: number, pinLng: number) {
    return this.addressLocation.preview(pinLat, pinLng);
  }

  async createAddress(
    customerId: string,
    dto: CreateAddressDto,
  ): Promise<CustomerAddress> {
    const location = await this.addressLocation.resolveForSave(
      dto.pinLat,
      dto.pinLng,
    );

    return this.prisma.$transaction(async (tx) => {
      await this.lockCustomer(tx, customerId);
      const count = await tx.customerAddress.count({ where: { customerId } });
      const isDefault = count === 0;
      const address = await tx.customerAddress.create({
        data: {
          customerId,
          label: dto.label,
          addressLine: dto.addressLine,
          landmark: dto.landmark ?? null,
          pinLat: dto.pinLat,
          pinLng: dto.pinLng,
          cityId: location.cityId,
          geoPoint: { type: 'Point', coordinates: [dto.pinLng, dto.pinLat] },
          isDefault,
        },
      });
      if (isDefault) {
        await tx.customer.update({
          where: { id: customerId },
          data: { defaultAddressId: address.id },
        });
      }
      return address;
    });
  }

  async updateAddress(
    customerId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ): Promise<CustomerAddress> {
    const address = await this.getOwnedAddress(customerId, addressId);

    const pinLat = dto.pinLat ?? address.pinLat;
    const pinLng = dto.pinLng ?? address.pinLng;
    const pinChanged = dto.pinLat !== undefined || dto.pinLng !== undefined;
    if (pinChanged) await this.assertNoLiveBookingForAddress(addressId);
    const location = pinChanged
      ? await this.addressLocation.resolveForSave(pinLat, pinLng)
      : null;

    return this.prisma.customerAddress.update({
      where: { id: addressId },
      data: {
        ...dto,
        ...(pinChanged
          ? {
              cityId: location!.cityId,
              geoPoint: { type: 'Point', coordinates: [pinLng, pinLat] },
            }
          : {}),
      },
    });
  }

  async deleteAddress(customerId: string, addressId: string): Promise<void> {
    await this.getOwnedAddress(customerId, addressId);
    await this.assertNoLiveBookingForAddress(addressId);
    await this.prisma.$transaction(async (tx) => {
      await this.lockCustomer(tx, customerId);
      const address = await tx.customerAddress.findFirst({
        where: { id: addressId, customerId },
      });
      if (!address) throw new NotFoundException('Address not found');
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { defaultAddressId: true },
      });
      const wasDefault =
        address.isDefault || customer?.defaultAddressId === addressId;

      if (!wasDefault) {
        await tx.customerAddress.delete({ where: { id: addressId } });
        return;
      }

      const replacement = await tx.customerAddress.findFirst({
        where: { customerId, id: { not: addressId } },
        orderBy: { createdAt: 'desc' },
      });
      await tx.customerAddress.delete({ where: { id: addressId } });
      if (replacement) {
        await tx.customerAddress.update({
          where: { id: replacement.id },
          data: { isDefault: true },
        });
      }
      await tx.customer.update({
        where: { id: customerId },
        data: { defaultAddressId: replacement?.id ?? null },
      });
    });
  }

  async setDefaultAddress(
    customerId: string,
    addressId: string,
  ): Promise<CustomerAddress> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockCustomer(tx, customerId);
      const address = await tx.customerAddress.findFirst({
        where: { id: addressId, customerId },
      });
      if (!address) throw new NotFoundException('Address not found');
      await tx.customerAddress.updateMany({
        where: { customerId },
        data: { isDefault: false },
      });
      const saved = await tx.customerAddress.update({
        where: { id: addressId },
        data: { isDefault: true },
      });
      await tx.customer.update({
        where: { id: customerId },
        data: { defaultAddressId: addressId },
      });
      return saved;
    });
  }

  /**
   * Real serviceability is Geo & Routing's job (reverse geocode, pincode
   * zones). This is the MVP stand-in until that module exists: is the city
   * itself active.
   */
  async checkServiceability(cityId: string): Promise<{ serviceable: boolean }> {
    const city = await this.prisma.city.findUnique({ where: { id: cityId } });
    return { serviceable: !!city?.isActive };
  }

  async block(id: string): Promise<Customer> {
    await this.getById(id);
    const updated = await this.prisma.customer.update({
      where: { id },
      data: { isBlocked: true },
    });

    await this.tokenService.revokeAllSessions('customer', id);

    return updated;
  }

  async unblock(id: string): Promise<Customer> {
    await this.getById(id);
    const updated = await this.prisma.customer.update({
      where: { id },
      data: { isBlocked: false },
    });

    return updated;
  }

  private async getOwnedAddress(
    customerId: string,
    addressId: string,
  ): Promise<CustomerAddress> {
    const address = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!address) throw new NotFoundException('Address not found');
    return address;
  }

  private async assertNoLiveBookingForAddress(
    addressId: string,
  ): Promise<void> {
    const liveBookingCount = await this.prisma.booking.count({
      where: {
        addressId,
        status: {
          in: [
            'created',
            'assigning',
            'assigned',
            'en_route',
            'arrived',
            'started',
          ],
        },
      },
    });
    if (liveBookingCount > 0) {
      throw apiError(
        'This address is used by an in-flight booking; create a new address instead',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async lockCustomer(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId}::uuid FOR UPDATE`;
  }

  private toProfile(customer: Customer): CustomerProfileDto {
    return {
      id: customer.id,
      phone: customer.phone,
      fullName: customer.fullName,
      email: customer.email,
      status: customer.status,
      defaultAddressId: customer.defaultAddressId,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }
}
