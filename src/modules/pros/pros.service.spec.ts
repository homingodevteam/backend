import { NotFoundException } from '@nestjs/common';
import { ProsService } from './pros.service';

function buildDeps() {
  const prisma = {
    pro: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    city: {
      findUnique: jest.fn(),
    },
    booking: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    bookingStatusEvent: { create: jest.fn() },
    proService: { count: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(prisma),
  );
  const redis = {
    geoAdd: jest.fn(),
    geoRemove: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
  };

  return { prisma, redis };
}

function buildService(deps: ReturnType<typeof buildDeps>): ProsService {
  return new ProsService(
    deps.prisma as never,
    deps.redis as never,
    { revokeAllSessions: jest.fn() } as never,
  );
}

describe('ProsService', () => {
  describe('getById', () => {
    it('404s for an unknown Pro', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(service.getById('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('suspend', () => {
    it('refuses to suspend a Pro that is not currently approved', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'applied',
      });
      const service = buildService(deps);

      await expect(
        service.suspend('p1', { reason: 'no-show' }, 'admin-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 409 }),
      });
      expect(deps.prisma.pro.update).not.toHaveBeenCalled();
    });

    it('suspends an approved Pro', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'approved',
      });
      deps.prisma.pro.update.mockResolvedValue({
        id: 'p1',
        status: 'suspended',
      });
      const service = buildService(deps);

      const result = await service.suspend(
        'p1',
        { reason: 'repeated no-shows' },
        'admin-1',
      );

      expect(result.status).toBe('suspended');
    });

    it('refuses to suspend without a reason', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'approved',
      });
      const service = buildService(deps);

      await expect(
        service.suspend('p1', { reason: '  ' }, 'admin-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 400 }),
      });
      expect(deps.prisma.pro.update).not.toHaveBeenCalled();
    });

    it('requires explicit handling when a live booking exists', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'approved',
      });
      deps.prisma.booking.findMany.mockResolvedValue([
        { id: 'b1', bookingNumber: 'HG-B1', status: 'arrived' },
      ]);
      const service = buildService(deps);

      await expect(
        service.suspend('p1', { reason: 'under investigation' }, 'admin-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 409 }),
      });
      expect(deps.prisma.pro.update).not.toHaveBeenCalled();
    });
  });

  describe('reinstate', () => {
    it('refuses to reinstate a Pro that is not currently suspended', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'approved',
      });
      const service = buildService(deps);

      await expect(service.reinstate('p1')).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 409 }),
      });
    });

    it('requires active service and availability gates', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'suspended',
        isAvailable: false,
      });
      deps.prisma.proService.count.mockResolvedValue(0);
      const service = buildService(deps);

      await expect(service.reinstate('p1')).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 409 }),
      });
    });
  });

  describe('setAvailability / bulkSetAvailability', () => {
    it('toggles availability and stamps availabilityUpdatedAt', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        isAvailable: false,
      });
      deps.prisma.pro.update.mockResolvedValue({ id: 'p1', isAvailable: true });
      const service = buildService(deps);

      await service.setAvailability('p1', true);

      expect(deps.prisma.pro.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p1' },
          data: expect.objectContaining({ isAvailable: true }),
        }),
      );
    });

    it('applies bulk availability to every Pro in the list individually', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique
        .mockResolvedValueOnce({ id: 'p1', isAvailable: false })
        .mockResolvedValueOnce({ id: 'p2', isAvailable: false });
      deps.prisma.pro.update
        .mockResolvedValueOnce({ id: 'p1', isAvailable: true })
        .mockResolvedValueOnce({ id: 'p2', isAvailable: true });
      const service = buildService(deps);

      const results = await service.bulkSetAvailability(['p1', 'p2'], true);

      expect(results).toHaveLength(2);
    });
  });

  describe('updateProfileByAdmin', () => {
    it('rejects assignment to a city that does not exist', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({ id: 'p1', cityId: null });
      deps.prisma.city.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(
        service.updateProfileByAdmin('p1', { cityId: 'missing' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 400 }),
      });
      expect(deps.prisma.pro.update).not.toHaveBeenCalled();
    });

    it('updates city and salary together', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        cityId: null,
        monthlySalary: null,
      });
      deps.prisma.city.findUnique.mockResolvedValue({
        id: 'city-1',
        isActive: true,
      });
      deps.prisma.pro.update.mockResolvedValue({
        id: 'p1',
        cityId: 'city-1',
        monthlySalary: 25000,
      });
      const service = buildService(deps);

      const result = await service.updateProfileByAdmin('p1', {
        cityId: 'city-1',
        monthlySalary: 25000,
      });

      expect(result.cityId).toBe('city-1');
      expect(deps.prisma.pro.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cityId: 'city-1',
            monthlySalary: 25000,
          }),
        }),
      );
    });
  });

  describe('ingestLocation', () => {
    it('writes to the Redis GEO index and cold-flushes Postgres', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'approved',
        isAvailable: true,
      });
      const service = buildService(deps);

      await service.ingestLocation('p1', { lat: 12.9, lng: 77.6 });

      expect(deps.redis.geoAdd).toHaveBeenCalledWith(
        'pros:live',
        77.6,
        12.9,
        'p1',
      );
      expect(deps.prisma.pro.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p1' },
          data: expect.objectContaining({
            lastKnownLat: 12.9,
            lastKnownLng: 77.6,
          }),
        }),
      );
    });

    /**
     * The ping is what makes a customer's map move. It is *published* rather
     * than handed to the socket layer directly because `BookingsModule`
     * already imports this module — Redis is the only route that is not a
     * cycle, and it is also what carries the frame to the instance actually
     * holding the customer's socket, which is rarely this one.
     */
    it('announces the movement so watching customers get pushed to', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'approved',
        isAvailable: true,
      });
      const service = buildService(deps);

      await service.ingestLocation('p1', { lat: 12.9, lng: 77.6 });

      expect(deps.redis.publish).toHaveBeenCalledWith(
        'tracking:positions',
        expect.objectContaining({ proId: 'p1', lat: 12.9, lng: 77.6 }),
      );
    });

    /**
     * The durable state — GEO index and the cold flush — is already written by
     * the time we announce. A Redis pub/sub hiccup must cost one map frame,
     * not the Pro's location update.
     */
    it('still succeeds when the announcement cannot be delivered', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'approved',
        isAvailable: true,
      });
      deps.redis.publish.mockRejectedValue(new Error('pubsub down'));
      const service = buildService(deps);

      await expect(
        service.ingestLocation('p1', { lat: 12.9, lng: 77.6 }),
      ).resolves.toBeUndefined();
      expect(deps.prisma.pro.update).toHaveBeenCalled();
    });
  });

  describe('generateEmployeeCode', () => {
    it('zero-pads the sequence value into an HG-##### code', async () => {
      const deps = buildDeps();
      deps.prisma.$queryRaw.mockResolvedValue([{ nextval: BigInt(7) }]);
      const service = buildService(deps);

      await expect(service.generateEmployeeCode()).resolves.toBe('HG-00007');
    });
  });
});
