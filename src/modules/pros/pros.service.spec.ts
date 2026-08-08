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
    $queryRaw: jest.fn(),
  };
  const redis = { geoAdd: jest.fn() };
  const auditLog = { record: jest.fn() };

  return { prisma, redis, auditLog };
}

function buildService(deps: ReturnType<typeof buildDeps>): ProsService {
  return new ProsService(
    deps.prisma as never,
    deps.redis as never,
    deps.auditLog as never,
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
        service.suspend('p1', 'admin-1', null),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 409 }),
      });
      expect(deps.prisma.pro.update).not.toHaveBeenCalled();
    });

    it('suspends an approved Pro and writes an audit log entry', async () => {
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

      const result = await service.suspend('p1', 'admin-1', '1.2.3.4');

      expect(result.status).toBe('suspended');
      expect(deps.auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'pro.suspend', entityId: 'p1' }),
      );
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

      await expect(
        service.reinstate('p1', 'admin-1', null),
      ).rejects.toMatchObject({
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

      await service.setAvailability('p1', true, 'admin-1', null);

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

      const results = await service.bulkSetAvailability(
        ['p1', 'p2'],
        true,
        'admin-1',
        null,
      );

      expect(results).toHaveLength(2);
      expect(deps.auditLog.record).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateProfileByAdmin', () => {
    it('rejects assignment to a city that does not exist', async () => {
      const deps = buildDeps();
      deps.prisma.pro.findUnique.mockResolvedValue({ id: 'p1', cityId: null });
      deps.prisma.city.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(
        service.updateProfileByAdmin(
          'p1',
          { cityId: 'missing' },
          'admin-1',
          null,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 400 }),
      });
      expect(deps.prisma.pro.update).not.toHaveBeenCalled();
    });

    it('updates city and salary together and audit-logs both', async () => {
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

      const result = await service.updateProfileByAdmin(
        'p1',
        { cityId: 'city-1', monthlySalary: 25000 },
        'admin-1',
        null,
      );

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
