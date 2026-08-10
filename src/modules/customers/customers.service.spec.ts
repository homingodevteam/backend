import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CustomersService } from './customers.service';

function buildDeps() {
  const prisma = {
    customer: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    customerAddress: {
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    booking: {
      count: jest.fn().mockResolvedValue(0),
    },
    city: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  // $transaction(callback) runs the callback against the same mock — every
  // method it calls on `tx` is the same jest.fn() the test already stubbed.
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(prisma),
  );

  const addressLocation = {
    preview: jest.fn(),
    resolveForSave: jest.fn().mockResolvedValue({
      cityId: 'city-1',
      suggestedAddressLine: 'Resolved address',
    }),
  };

  return { prisma, addressLocation };
}

function buildService(deps: ReturnType<typeof buildDeps>): CustomersService {
  return new CustomersService(
    deps.prisma as never,
    {
      revokeAllSessions: jest.fn(),
    } as never,
    deps.addressLocation as never,
  );
}

describe('CustomersService', () => {
  describe('createAddress', () => {
    it('makes the first address for a customer the default automatically', async () => {
      const deps = buildDeps();
      deps.prisma.customerAddress.create.mockResolvedValue({
        id: 'addr-1',
        customerId: 'cust-1',
        isDefault: true,
      });
      deps.prisma.customerAddress.count.mockResolvedValue(0);
      const service = buildService(deps);

      const result = await service.createAddress('cust-1', {
        label: 'home',
        addressLine: '1 Main St',
        pinLat: 12.9,
        pinLng: 77.6,
      });

      expect(result.isDefault).toBe(true);
      expect(deps.prisma.customerAddress.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cityId: 'city-1',
          isDefault: true,
          geoPoint: { type: 'Point', coordinates: [77.6, 12.9] },
        }),
      });
      expect(deps.prisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cust-1' },
          data: { defaultAddressId: 'addr-1' },
        }),
      );
    });

    it('does not touch the default flag for a second address', async () => {
      const deps = buildDeps();
      deps.prisma.customerAddress.create.mockResolvedValue({
        id: 'addr-2',
        customerId: 'cust-1',
        isDefault: false,
      });
      deps.prisma.customerAddress.count.mockResolvedValue(1);
      const service = buildService(deps);

      await service.createAddress('cust-1', {
        label: 'office',
        addressLine: '2 Main St',
        pinLat: 12.9,
        pinLng: 77.6,
      });

      expect(deps.prisma.customerAddress.update).not.toHaveBeenCalled();
      expect(deps.prisma.customer.update).not.toHaveBeenCalled();
    });

    it('rejects an address in an inactive/unknown city', async () => {
      const deps = buildDeps();
      deps.addressLocation.resolveForSave.mockRejectedValue(
        new UnprocessableEntityException('outside coverage'),
      );
      const service = buildService(deps);

      await expect(
        service.createAddress('cust-1', {
          label: 'home',
          addressLine: '1 Main St',
          pinLat: 12.9,
          pinLng: 77.6,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(deps.prisma.customerAddress.create).not.toHaveBeenCalled();
    });
  });

  describe('profile', () => {
    it('returns only customer-facing profile fields', async () => {
      const deps = buildDeps();
      deps.prisma.customer.findUnique.mockResolvedValue({
        id: 'cust-1',
        phone: '+919000000001',
        fullName: 'Customer',
        email: 'customer@example.com',
        status: 'verified',
        defaultAddressId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
        pushToken: 'must-not-leak',
        razorpayCustomerId: 'must-not-leak',
      });
      const service = buildService(deps);

      const profile = await service.getProfile('cust-1');

      expect(profile).not.toHaveProperty('pushToken');
      expect(profile).not.toHaveProperty('razorpayCustomerId');
      expect(profile).toEqual(expect.objectContaining({ id: 'cust-1' }));
    });
  });

  describe('updateAddress', () => {
    it('re-resolves city and GeoJSON only when the pin changes', async () => {
      const deps = buildDeps();
      deps.prisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        customerId: 'cust-1',
        pinLat: 22.7,
        pinLng: 75.8,
      });
      deps.addressLocation.resolveForSave.mockResolvedValue({
        cityId: 'city-2',
        suggestedAddressLine: 'New place',
      });
      deps.prisma.customerAddress.update.mockResolvedValue({ id: 'addr-1' });
      const service = buildService(deps);

      await service.updateAddress('cust-1', 'addr-1', { pinLng: 72.8 });

      expect(deps.addressLocation.resolveForSave).toHaveBeenCalledWith(
        22.7,
        72.8,
      );
      expect(deps.prisma.customerAddress.update).toHaveBeenCalledWith({
        where: { id: 'addr-1' },
        data: expect.objectContaining({
          cityId: 'city-2',
          geoPoint: { type: 'Point', coordinates: [72.8, 22.7] },
        }),
      });
    });

    it('blocks a pin change while a live booking references the address', async () => {
      const deps = buildDeps();
      deps.prisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        customerId: 'cust-1',
        pinLat: 22.7,
        pinLng: 75.8,
      });
      deps.prisma.booking.count.mockResolvedValue(1);
      const service = buildService(deps);

      await expect(
        service.updateAddress('cust-1', 'addr-1', { pinLng: 72.8 }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 409 }),
      });
      expect(deps.addressLocation.resolveForSave).not.toHaveBeenCalled();
      expect(deps.prisma.customerAddress.update).not.toHaveBeenCalled();
    });
  });

  describe('checkServiceability', () => {
    it('is serviceable only when the city exists and is active', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue({ isActive: true });
      const service = buildService(deps);

      await expect(service.checkServiceability('city-1')).resolves.toEqual({
        serviceable: true,
      });
    });

    it('is not serviceable when the city is inactive', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue({ isActive: false });
      const service = buildService(deps);

      await expect(service.checkServiceability('city-1')).resolves.toEqual({
        serviceable: false,
      });
    });

    it('is not serviceable when the city does not exist', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(service.checkServiceability('missing')).resolves.toEqual({
        serviceable: false,
      });
    });
  });

  describe('block / unblock', () => {
    it('blocks a customer and revokes its sessions', async () => {
      const deps = buildDeps();
      deps.prisma.customer.findUnique.mockResolvedValue({
        id: 'cust-1',
        isBlocked: false,
      });
      deps.prisma.customer.update.mockResolvedValue({
        id: 'cust-1',
        isBlocked: true,
      });
      const service = buildService(deps);

      const result = await service.block('cust-1');

      expect(result.isBlocked).toBe(true);
    });

    it('404s blocking a customer that does not exist', async () => {
      const deps = buildDeps();
      deps.prisma.customer.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(service.block('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteAddress', () => {
    it('404s deleting an address that does not belong to the customer', async () => {
      const deps = buildDeps();
      deps.prisma.customerAddress.findFirst.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(
        service.deleteAddress('cust-1', 'someone-elses-address'),
      ).rejects.toThrow(NotFoundException);
      expect(deps.prisma.customerAddress.delete).not.toHaveBeenCalled();
    });

    it('promotes another address when deleting the default', async () => {
      const deps = buildDeps();
      deps.prisma.customerAddress.findFirst
        .mockResolvedValueOnce({
          id: 'addr-1',
          customerId: 'cust-1',
          isDefault: true,
        })
        .mockResolvedValueOnce({
          id: 'addr-1',
          customerId: 'cust-1',
          isDefault: true,
        })
        .mockResolvedValueOnce({ id: 'addr-2', customerId: 'cust-1' });
      deps.prisma.customer.findUnique.mockResolvedValue({
        defaultAddressId: 'addr-1',
      });
      const service = buildService(deps);

      await service.deleteAddress('cust-1', 'addr-1');

      expect(deps.prisma.customerAddress.update).toHaveBeenCalledWith({
        where: { id: 'addr-2' },
        data: { isDefault: true },
      });
      expect(deps.prisma.customer.update).toHaveBeenCalledWith({
        where: { id: 'cust-1' },
        data: { defaultAddressId: 'addr-2' },
      });
    });
  });
});
