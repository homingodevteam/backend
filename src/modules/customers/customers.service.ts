import { Injectable, NotFoundException } from '@nestjs/common';
import type { Customer, CustomerAddress } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../identity/services/audit-log.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async getById(id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto): Promise<Customer> {
    await this.getById(id);
    return this.prisma.customer.update({ where: { id }, data: dto });
  }

  listAddresses(customerId: string): Promise<CustomerAddress[]> {
    return this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createAddress(
    customerId: string,
    dto: CreateAddressDto,
  ): Promise<CustomerAddress> {
    await this.assertCityActive(dto.cityId);

    const address = await this.prisma.customerAddress.create({
      data: {
        customerId,
        label: dto.label,
        addressLine: dto.addressLine,
        landmark: dto.landmark ?? null,
        pinLat: dto.pinLat,
        pinLng: dto.pinLng,
        cityId: dto.cityId,
        geoPoint: { type: 'Point', coordinates: [dto.pinLng, dto.pinLat] },
      },
    });

    // First address for this customer becomes the default automatically.
    const count = await this.prisma.customerAddress.count({
      where: { customerId },
    });
    if (count === 1) {
      return this.setDefaultAddress(customerId, address.id);
    }

    return address;
  }

  async updateAddress(
    customerId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ): Promise<CustomerAddress> {
    const address = await this.getOwnedAddress(customerId, addressId);

    // TODO(module 4 Booking): block this edit if the address is referenced
    // by a booking that hasn't reached a terminal state yet. Booking doesn't
    // exist in this pass, so there is nothing to check against — wire this
    // guard as soon as Booking.addressId exists.

    if (dto.cityId) await this.assertCityActive(dto.cityId);

    const pinLat = dto.pinLat ?? address.pinLat;
    const pinLng = dto.pinLng ?? address.pinLng;

    return this.prisma.customerAddress.update({
      where: { id: addressId },
      data: {
        ...dto,
        ...(dto.pinLat !== undefined || dto.pinLng !== undefined
          ? { geoPoint: { type: 'Point', coordinates: [pinLng, pinLat] } }
          : {}),
      },
    });
  }

  async deleteAddress(customerId: string, addressId: string): Promise<void> {
    await this.getOwnedAddress(customerId, addressId);
    // Same in-flight-booking gap as updateAddress above.
    await this.prisma.customerAddress.delete({ where: { id: addressId } });
  }

  async setDefaultAddress(
    customerId: string,
    addressId: string,
  ): Promise<CustomerAddress> {
    await this.getOwnedAddress(customerId, addressId);

    return this.prisma.$transaction(async (tx) => {
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

  async block(
    id: string,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<Customer> {
    const before = await this.getById(id);
    const updated = await this.prisma.customer.update({
      where: { id },
      data: { isBlocked: true },
    });

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: 'customer.block',
      entityType: 'Customer',
      entityId: id,
      before: { ...before },
      after: { ...updated },
      ipAddress,
    });

    return updated;
  }

  async unblock(
    id: string,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<Customer> {
    const before = await this.getById(id);
    const updated = await this.prisma.customer.update({
      where: { id },
      data: { isBlocked: false },
    });

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: 'customer.unblock',
      entityType: 'Customer',
      entityId: id,
      before: { ...before },
      after: { ...updated },
      ipAddress,
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

  private async assertCityActive(cityId: string): Promise<void> {
    const city = await this.prisma.city.findUnique({ where: { id: cityId } });
    if (!city || !city.isActive) {
      throw new NotFoundException('City not found or not active');
    }
  }
}
