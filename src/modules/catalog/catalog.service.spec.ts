import { HttpException, HttpStatus } from '@nestjs/common';
import { CatalogService } from './catalog.service';

function buildDeps() {
  const prisma = {
    city: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const pros = { countApprovedInCity: jest.fn().mockResolvedValue(0) };
  return { prisma, pros };
}

function buildService(deps: ReturnType<typeof buildDeps>): CatalogService {
  return new CatalogService(deps.prisma as never, deps.pros as never);
}

async function captureStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

const city = {
  id: 'city-1',
  name: 'Indore',
  state: 'Madhya Pradesh',
  timezone: 'Asia/Kolkata',
  isActive: false,
};

describe('CatalogService', () => {
  describe('city activation — US-3.9 supply gate', () => {
    it('refuses to launch a city with no approved Pros', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue(city);
      deps.pros.countApprovedInCity.mockResolvedValue(0);
      const service = buildService(deps);

      await expect(
        captureStatus(service.setActivation('city-1', true)),
      ).resolves.toBe(HttpStatus.CONFLICT);
      // The whole point: no booking can be taken in a city nobody can serve.
      expect(deps.prisma.city.update).not.toHaveBeenCalled();
    });

    it('launches when supply exists', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue(city);
      deps.pros.countApprovedInCity.mockResolvedValue(4);
      deps.prisma.city.update.mockResolvedValue({ ...city, isActive: true });
      const service = buildService(deps);

      await service.setActivation('city-1', true);

      expect(deps.prisma.city.update).toHaveBeenCalledWith({
        where: { id: 'city-1' },
        data: { isActive: true },
      });
    });

    it('launches an unstaffed city when ops explicitly acknowledges it', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue(city);
      deps.pros.countApprovedInCity.mockResolvedValue(0);
      deps.prisma.city.update.mockResolvedValue({ ...city, isActive: true });
      const service = buildService(deps);

      await service.setActivation('city-1', true, true);

      expect(deps.prisma.city.update).toHaveBeenCalled();
      // The override skips the question entirely rather than asking and ignoring.
      expect(deps.pros.countApprovedInCity).not.toHaveBeenCalled();
    });

    it('never gates a pause — supply is irrelevant when closing a city', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue({
        ...city,
        isActive: true,
      });
      deps.prisma.city.update.mockResolvedValue(city);
      const service = buildService(deps);

      await service.setActivation('city-1', false);

      expect(deps.pros.countApprovedInCity).not.toHaveBeenCalled();
      expect(deps.prisma.city.update).toHaveBeenCalledWith({
        where: { id: 'city-1' },
        data: { isActive: false },
      });
    });

    it('404s for an unknown city before consulting supply', async () => {
      const deps = buildDeps();
      deps.prisma.city.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(
        captureStatus(service.setActivation('nope', true)),
      ).resolves.toBe(HttpStatus.NOT_FOUND);
      expect(deps.pros.countApprovedInCity).not.toHaveBeenCalled();
    });
  });

  describe('city registry', () => {
    it('creates a city dark by default', async () => {
      const deps = buildDeps();
      deps.prisma.city.create.mockResolvedValue(city);
      const service = buildService(deps);

      await service.create({
        name: 'Bhopal',
        state: 'Madhya Pradesh',
        timezone: 'Asia/Kolkata',
      });

      expect(deps.prisma.city.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isActive: false }),
      });
    });

    it('serves only active cities to the customer app', async () => {
      const deps = buildDeps();
      deps.prisma.city.findMany.mockResolvedValue([]);
      const service = buildService(deps);

      await service.findActiveCities();

      expect(deps.prisma.city.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      });
    });

    it('shows unlaunched cities on the admin listing', async () => {
      const deps = buildDeps();
      deps.prisma.city.findMany.mockResolvedValue([]);
      const service = buildService(deps);

      await service.findAll();

      expect(deps.prisma.city.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
      });
    });
  });
});
