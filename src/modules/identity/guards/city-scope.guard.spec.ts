import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { CityScopeGuard } from './city-scope.guard';

function context(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('CityScopeGuard', () => {
  const prisma = {
    pro: { findUnique: jest.fn(), findMany: jest.fn() },
    proApplication: { findUnique: jest.fn() },
    customerAddress: { findMany: jest.fn() },
  };

  beforeEach(() => jest.clearAllMocks());

  it('allows an empty city scope as platform-wide access', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue('pro') };
    const guard = new CityScopeGuard(prisma as never, reflector as never);
    await expect(
      guard.canActivate(
        context({ user: { actorType: 'admin', cityScope: [] } }),
      ),
    ).resolves.toBe(true);
    expect(prisma.pro.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a write when the target Pro is outside scope', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue('pro') };
    prisma.pro.findUnique.mockResolvedValue({ cityId: 'mumbai' });
    const guard = new CityScopeGuard(prisma as never, reflector as never);
    await expect(
      guard.canActivate(
        context({
          user: { actorType: 'admin', cityScope: ['indore'] },
          params: { id: 'p1' },
          query: {},
          body: {},
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects the whole bulk operation if one Pro is outside scope', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue('bulkPros'),
    };
    prisma.pro.findMany.mockResolvedValue([
      { id: 'p1', cityId: 'indore' },
      { id: 'p2', cityId: 'mumbai' },
    ]);
    const guard = new CityScopeGuard(prisma as never, reflector as never);
    await expect(
      guard.canActivate(
        context({
          user: { actorType: 'admin', cityScope: ['indore'] },
          params: {},
          query: {},
          body: { proIds: ['p1', 'p2'] },
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
