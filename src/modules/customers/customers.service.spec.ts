import { NotFoundException } from '@nestjs/common';
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
    city: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  // $transaction(callback) runs the callback against the same mock — every
  // method it calls on `tx` is the same jest.fn() the test already stubbed.
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(prisma),
  );

  const auditLog = { record: jest.fn() };

  return { prisma, auditLog };
}

function buildService(deps: ReturnType<typeof buildDeps>): CustomersService {
  return new CustomersService(deps.prisma as never, deps.auditLog as never);
}

describe('CustomersService', () => {
  describe('createAddress', () => {
    it('makes the first address for a customer the default automatically', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue({
        id: 'city-1',
        isActive: true,
      });
      deps.prisma.customerAddress.create.mockResolvedValue({
        id: 'addr-1',
        customerId: 'cust-1',
        isDefault: false,
      });
      deps.prisma.customerAddress.count.mockResolvedValue(1);
      deps.prisma.customerAddress.findFirst.mockResolvedValue({
        id: 'addr-1',
        customerId: 'cust-1',
      });
      deps.prisma.customerAddress.update.mockResolvedValue({
        id: 'addr-1',
        isDefault: true,
      });
      const service = buildService(deps);

      const result = await service.createAddress('cust-1', {
        label: 'home',
        addressLine: '1 Main St',
        pinLat: 12.9,
        pinLng: 77.6,
        cityId: 'city-1',
      });

      expect(result.isDefault).toBe(true);
      expect(deps.prisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cust-1' },
          data: { defaultAddressId: 'addr-1' },
        }),
      );
    });

    it('does not touch the default flag for a second address', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue({
        id: 'city-1',
        isActive: true,
      });
      deps.prisma.customerAddress.create.mockResolvedValue({
        id: 'addr-2',
        customerId: 'cust-1',
        isDefault: false,
      });
      deps.prisma.customerAddress.count.mockResolvedValue(2);
      const service = buildService(deps);

      await service.createAddress('cust-1', {
        label: 'office',
        addressLine: '2 Main St',
        pinLat: 12.9,
        pinLng: 77.6,
        cityId: 'city-1',
      });

      expect(deps.prisma.customerAddress.update).not.toHaveBeenCalled();
      expect(deps.prisma.customer.update).not.toHaveBeenCalled();
    });

    it('rejects an address in an inactive/unknown city', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(
        service.createAddress('cust-1', {
          label: 'home',
          addressLine: '1 Main St',
          pinLat: 12.9,
          pinLng: 77.6,
          cityId: 'missing-city',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(deps.prisma.customerAddress.create).not.toHaveBeenCalled();
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
    it('blocks a customer and writes an audit log entry', async () => {
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

      const result = await service.block('cust-1', 'admin-1', '1.2.3.4');

      expect(result.isBlocked).toBe(true);
      expect(deps.auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'customer.block',
          adminUserId: 'admin-1',
          entityId: 'cust-1',
          ipAddress: '1.2.3.4',
        }),
      );
    });

    it('404s blocking a customer that does not exist', async () => {
      const deps = buildDeps();
      deps.prisma.customer.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(service.block('missing', 'admin-1', null)).rejects.toThrow(
        NotFoundException,
      );
      expect(deps.auditLog.record).not.toHaveBeenCalled();
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
  });
});
