import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';

function buildContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  it('allows the request through when no permissions are required', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    };
    const prisma = { role: { findUnique: jest.fn() } };
    const guard = new PermissionsGuard(reflector as never, prisma as never);

    await expect(
      guard.canActivate(buildContext({ actorType: 'customer' })),
    ).resolves.toBe(true);
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a non-admin actor outright, even with permissions required', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(['pro.moderate']),
    };
    const prisma = { role: { findUnique: jest.fn() } };
    const guard = new PermissionsGuard(reflector as never, prisma as never);

    await expect(
      guard.canActivate(buildContext({ actorType: 'pro' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when the role no longer exists', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(['pro.moderate']),
    };
    const prisma = { role: { findUnique: jest.fn().mockResolvedValue(null) } };
    const guard = new PermissionsGuard(reflector as never, prisma as never);

    await expect(
      guard.canActivate(
        buildContext({ actorType: 'admin', roleId: 'stale-role' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when the role is missing the required permission', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(['pro.moderate']),
    };
    const prisma = {
      role: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ permissionCodes: ['customer.moderate'] }),
      },
    };
    const guard = new PermissionsGuard(reflector as never, prisma as never);

    await expect(
      guard.canActivate(buildContext({ actorType: 'admin', roleId: 'r1' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows the request through when the role has every required permission', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue(['pro.moderate', 'pro.availability.set']),
    };
    const prisma = {
      role: {
        findUnique: jest.fn().mockResolvedValue({
          permissionCodes: ['pro.moderate', 'pro.availability.set'],
        }),
      },
    };
    const guard = new PermissionsGuard(reflector as never, prisma as never);

    await expect(
      guard.canActivate(buildContext({ actorType: 'admin', roleId: 'r1' })),
    ).resolves.toBe(true);
  });
});
