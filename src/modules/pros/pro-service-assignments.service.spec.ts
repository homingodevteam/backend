import { HttpException, HttpStatus } from '@nestjs/common';
import { ProServiceAssignmentsService } from './pro-service-assignments.service';

function buildDeps() {
  const prisma = {
    proService: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const catalog = {
    getServiceOrFail: jest.fn(),
  };
  /**
   * Module 10's activation gate, in its default shape: permissive. In a real
   * deployment without the training module this is `NoOpTrainingGateService`,
   * which resolves; with it, enforcement still depends on
   * `training.gateActivation`, which ships off.
   */
  const trainingGate = {
    assertEligible: jest.fn().mockResolvedValue(undefined),
  };
  return { prisma, catalog, trainingGate };
}

function buildService(
  deps: ReturnType<typeof buildDeps>,
): ProServiceAssignmentsService {
  return new ProServiceAssignmentsService(
    deps.prisma as never,
    deps.catalog as never,
    deps.trainingGate,
  );
}

/** What `catalog.getServiceOrFail` throws for an id that resolves to nothing. */
function notFound(): HttpException {
  return new HttpException('Service not found', HttpStatus.NOT_FOUND);
}

describe('ProServiceAssignmentsService', () => {
  describe('assign', () => {
    it('rejects a serviceId that is not in the catalogue', async () => {
      // The gap module 3 closes: before the catalog existed this accepted any
      // string, producing a Pro competent at a service nobody could book —
      // invisible until dispatch found no candidates.
      const deps = buildDeps();
      deps.catalog.getServiceOrFail.mockRejectedValue(notFound());
      const service = buildService(deps);

      await expect(
        service.assign('pro-1', { serviceId: 'not-a-real-service' }),
      ).rejects.toBeInstanceOf(HttpException);
      expect(deps.prisma.proService.create).not.toHaveBeenCalled();
    });

    it('validates against the catalog before checking for a duplicate', async () => {
      // Order matters: a bad id should read as "no such service", not as
      // "already assigned".
      const deps = buildDeps();
      deps.catalog.getServiceOrFail.mockRejectedValue(notFound());
      const service = buildService(deps);

      await expect(
        service.assign('pro-1', { serviceId: 'bogus' }),
      ).rejects.toBeInstanceOf(HttpException);
      expect(deps.prisma.proService.findUnique).not.toHaveBeenCalled();
    });

    it('accepts a draft service — Pros are trained ahead of a launch', async () => {
      const deps = buildDeps();
      deps.catalog.getServiceOrFail.mockResolvedValue({
        id: 'svc-draft',
        isActive: false,
      });
      deps.prisma.proService.findUnique.mockResolvedValue(null);
      deps.prisma.proService.create.mockResolvedValue({ id: 'ps-1' });
      const service = buildService(deps);

      await service.assign('pro-1', { serviceId: 'svc-draft' });

      expect(deps.prisma.proService.create).toHaveBeenCalledWith({
        data: {
          proId: 'pro-1',
          serviceId: 'svc-draft',
          proficiency: 'trainee',
          isActive: true,
        },
      });
    });

    it('409s on a duplicate assignment', async () => {
      const deps = buildDeps();
      deps.catalog.getServiceOrFail.mockResolvedValue({ id: 'svc-1' });
      deps.prisma.proService.findUnique.mockResolvedValue({ id: 'existing' });
      const service = buildService(deps);

      try {
        await service.assign('pro-1', { serviceId: 'svc-1' });
        throw new Error('Expected a conflict');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
      }
      expect(deps.prisma.proService.create).not.toHaveBeenCalled();
    });

    it('honours an explicit proficiency', async () => {
      const deps = buildDeps();
      deps.catalog.getServiceOrFail.mockResolvedValue({ id: 'svc-1' });
      deps.prisma.proService.findUnique.mockResolvedValue(null);
      deps.prisma.proService.create.mockResolvedValue({ id: 'ps-1' });
      const service = buildService(deps);

      await service.assign('pro-1', {
        serviceId: 'svc-1',
        proficiency: 'expert',
      });

      expect(deps.prisma.proService.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ proficiency: 'expert' }),
      });
    });
  });
});
