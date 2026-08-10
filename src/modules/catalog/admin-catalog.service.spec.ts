import { HttpException, HttpStatus } from '@nestjs/common';
import { AdminCatalogService } from './admin-catalog.service';

function buildDeps() {
  const prisma = {
    serviceCategory: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    service: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  return { prisma };
}

function buildService(deps: ReturnType<typeof buildDeps>): AdminCatalogService {
  return new AdminCatalogService(deps.prisma as never);
}

const rootCategory = {
  id: 'cat-root',
  name: 'Home Cleaning',
  slug: 'home-cleaning',
  parentCategoryId: null,
  isActive: true,
};

const childCategory = {
  id: 'cat-child',
  name: 'Deep Cleaning',
  slug: 'deep-cleaning',
  parentCategoryId: 'cat-root',
  isActive: true,
};

const draftService = {
  id: 'svc-1',
  categoryId: 'cat-child',
  name: 'Deep Clean 2BHK',
  durationMinutes: 240,
  flatPrice: '4999.00',
  commissionType: null,
  commissionValue: null,
  supportsInstant: false,
  supportsScheduled: true,
  supportsRecurring: false,
  isActive: false,
};

/** Reads the status off the HttpException `apiError` produces. */
function statusOf(error: unknown): number | undefined {
  return error instanceof HttpException ? error.getStatus() : undefined;
}

async function captureStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return statusOf(error) ?? -1;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

describe('AdminCatalogService', () => {
  describe('service activation — US-3.11', () => {
    it('refuses to activate a service with no commission rate', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(draftService);
      const service = buildService(deps);

      await expect(
        captureStatus(service.setServiceActivation('svc-1', true)),
      ).resolves.toBe(HttpStatus.CONFLICT);
      // The point of the rule: nothing was written.
      expect(deps.prisma.service.update).not.toHaveBeenCalled();
    });

    it('refuses to activate a service whose category is inactive', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        ...draftService,
        commissionType: 'percent',
        commissionValue: '30.00',
      });
      deps.prisma.serviceCategory.findUnique.mockResolvedValue({
        ...childCategory,
        isActive: false,
      });
      const service = buildService(deps);

      await expect(
        captureStatus(service.setServiceActivation('svc-1', true)),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.prisma.service.update).not.toHaveBeenCalled();
    });

    it('refuses to activate a service no booking flow can reach', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        ...draftService,
        commissionType: 'flat',
        commissionValue: '220.00',
        supportsInstant: false,
        supportsScheduled: false,
        supportsRecurring: false,
      });
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(childCategory);
      const service = buildService(deps);

      await expect(
        captureStatus(service.setServiceActivation('svc-1', true)),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.prisma.service.update).not.toHaveBeenCalled();
    });

    it('activates when the rate, the category and a booking type are all in place', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        ...draftService,
        commissionType: 'percent',
        commissionValue: '30.00',
      });
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(childCategory);
      deps.prisma.service.update.mockResolvedValue({
        ...draftService,
        isActive: true,
      });
      const service = buildService(deps);

      await service.setServiceActivation('svc-1', true);

      expect(deps.prisma.service.update).toHaveBeenCalledWith({
        where: { id: 'svc-1' },
        data: { isActive: true },
      });
    });

    it('deactivates unconditionally, without checking anything — US-3.7', async () => {
      const deps = buildDeps();
      // No commission, no active category: none of it should matter.
      deps.prisma.service.findUnique.mockResolvedValue(draftService);
      deps.prisma.service.update.mockResolvedValue({
        ...draftService,
        isActive: false,
      });
      const service = buildService(deps);

      await service.setServiceActivation('svc-1', false);

      expect(deps.prisma.service.update).toHaveBeenCalledWith({
        where: { id: 'svc-1' },
        data: { isActive: false },
      });
      expect(deps.prisma.serviceCategory.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('commission rates — US-3.10', () => {
    it('rejects a percentage above 100', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(draftService);
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.setCommission('svc-1', {
            commissionType: 'percent',
            commissionValue: '120',
          }),
        ),
      ).resolves.toBe(HttpStatus.BAD_REQUEST);
    });

    it('allows a flat rate above 100 — rupees, not percent', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(draftService);
      deps.prisma.service.update.mockResolvedValue(draftService);
      const service = buildService(deps);

      await service.setCommission('svc-1', {
        commissionType: 'flat',
        commissionValue: '220.00',
      });

      expect(deps.prisma.service.update).toHaveBeenCalledWith({
        where: { id: 'svc-1' },
        data: { commissionType: 'flat', commissionValue: '220.00' },
      });
    });

    it('rejects a negative rate', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(draftService);
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.setCommission('svc-1', {
            commissionType: 'flat',
            commissionValue: '-5',
          }),
        ),
      ).resolves.toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('services are created as drafts', () => {
    it('never honours an activation implied at creation', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(childCategory);
      deps.prisma.service.create.mockResolvedValue(draftService);
      const service = buildService(deps);

      await service.createService({
        categoryId: 'cat-child',
        name: 'Deep Clean 2BHK',
        durationMinutes: 240,
        flatPrice: '4999.00',
      });

      expect(deps.prisma.service.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isActive: false }),
        }),
      );
    });

    it('404s when the category does not exist', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.createService({
            categoryId: 'nope',
            name: 'Orphan',
            durationMinutes: 30,
            flatPrice: '99.00',
          }),
        ),
      ).resolves.toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('updating a service', () => {
    it('refuses to turn off the last booking type on a live service', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        ...draftService,
        isActive: true,
        supportsInstant: false,
        supportsScheduled: true,
        supportsRecurring: false,
      });
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.updateService('svc-1', { supportsScheduled: false }),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.prisma.service.update).not.toHaveBeenCalled();
    });

    it('allows it on a draft, which nobody can book yet', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(draftService);
      deps.prisma.service.update.mockResolvedValue(draftService);
      const service = buildService(deps);

      await service.updateService('svc-1', { supportsScheduled: false });

      expect(deps.prisma.service.update).toHaveBeenCalled();
    });

    it('does not let a price edit reach the commission columns', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(draftService);
      deps.prisma.service.update.mockResolvedValue(draftService);
      const service = buildService(deps);

      await service.updateService('svc-1', { flatPrice: '5499.00' });

      const [[call]] = deps.prisma.service.update.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      expect(call.data).not.toHaveProperty('commissionType');
      expect(call.data).not.toHaveProperty('commissionValue');
      expect(call.data).not.toHaveProperty('isActive');
    });
  });

  describe('category tree depth — two levels', () => {
    it('refuses to file a category under a sub-category', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(childCategory);
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.createCategory({
            name: 'Sofa Cleaning',
            slug: 'sofa-cleaning',
            parentCategoryId: 'cat-child',
          }),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    it('refuses to make a category its own parent', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(rootCategory);
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.updateCategory('cat-root', { parentCategoryId: 'cat-root' }),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    it('refuses to demote a root that still has children', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique
        .mockResolvedValueOnce(rootCategory) // the row being updated
        .mockResolvedValueOnce({ ...rootCategory, id: 'cat-other' }); // proposed parent
      deps.prisma.serviceCategory.count.mockResolvedValue(2);
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.updateCategory('cat-root', { parentCategoryId: 'cat-other' }),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.prisma.serviceCategory.update).not.toHaveBeenCalled();
    });

    it('allows a root as a parent', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique
        .mockResolvedValueOnce(rootCategory) // assertMayBeParent
        .mockResolvedValueOnce(null); // slug is free
      deps.prisma.serviceCategory.create.mockResolvedValue(childCategory);
      const service = buildService(deps);

      await service.createCategory({
        name: 'Sofa Cleaning',
        slug: 'sofa-cleaning',
        parentCategoryId: 'cat-root',
      });

      expect(deps.prisma.serviceCategory.create).toHaveBeenCalled();
    });
  });

  describe('category deletion — US-3.8', () => {
    it('refuses while services still reference it', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(childCategory);
      deps.prisma.serviceCategory.count.mockResolvedValue(0);
      deps.prisma.service.count.mockResolvedValue(3);
      const service = buildService(deps);

      await expect(
        captureStatus(service.deleteCategory('cat-child')),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.prisma.serviceCategory.delete).not.toHaveBeenCalled();
    });

    it('refuses while child categories still reference it', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(rootCategory);
      deps.prisma.serviceCategory.count.mockResolvedValue(1);
      deps.prisma.service.count.mockResolvedValue(0);
      const service = buildService(deps);

      await expect(
        captureStatus(service.deleteCategory('cat-root')),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.prisma.serviceCategory.delete).not.toHaveBeenCalled();
    });

    it('deletes an empty category', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(childCategory);
      const service = buildService(deps);

      await service.deleteCategory('cat-child');

      expect(deps.prisma.serviceCategory.delete).toHaveBeenCalledWith({
        where: { id: 'cat-child' },
      });
    });
  });

  describe('category activation', () => {
    it('refuses to activate a child under an inactive parent', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique
        .mockResolvedValueOnce(childCategory)
        .mockResolvedValueOnce({ ...rootCategory, isActive: false });
      const service = buildService(deps);

      await expect(
        captureStatus(service.setCategoryActivation('cat-child', true)),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    it('deactivates without touching any child or service flag', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(rootCategory);
      deps.prisma.serviceCategory.update.mockResolvedValue({
        ...rootCategory,
        isActive: false,
      });
      const service = buildService(deps);

      await service.setCategoryActivation('cat-root', false);

      expect(deps.prisma.serviceCategory.update).toHaveBeenCalledWith({
        where: { id: 'cat-root' },
        data: { isActive: false },
      });
      expect(deps.prisma.service.update).not.toHaveBeenCalled();
    });
  });

  describe('slugs', () => {
    it('rejects a duplicate slug', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findUnique.mockResolvedValue(rootCategory);
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.createCategory({
            name: 'Another Home Cleaning',
            slug: 'home-cleaning',
          }),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });
  });
});
