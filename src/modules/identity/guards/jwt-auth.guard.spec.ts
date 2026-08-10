import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

function context() {
  const request = { headers: { authorization: 'Bearer token' } };
  return {
    request,
    value: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext,
  };
}

describe('JwtAuthGuard suspended Pro access', () => {
  it('allows an explicitly marked read-only history route', async () => {
    const tokenService = {
      verifyAccessToken: jest
        .fn()
        .mockResolvedValue({ actorType: 'pro', id: 'p1' }),
      resolveCurrentIdentity: jest.fn().mockResolvedValue({
        actorType: 'pro',
        id: 'p1',
        accessMode: 'suspended_read_only',
      }),
      revokeAllSessions: jest.fn(),
    };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    const guard = new JwtAuthGuard(tokenService as never, reflector as never);

    await expect(guard.canActivate(context().value)).resolves.toBe(true);
  });

  it('blocks a suspended Pro from an ordinary operational route', async () => {
    const tokenService = {
      verifyAccessToken: jest
        .fn()
        .mockResolvedValue({ actorType: 'pro', id: 'p1' }),
      resolveCurrentIdentity: jest.fn().mockResolvedValue({
        actorType: 'pro',
        id: 'p1',
        accessMode: 'suspended_read_only',
      }),
      revokeAllSessions: jest.fn(),
    };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const guard = new JwtAuthGuard(tokenService as never, reflector as never);

    await expect(guard.canActivate(context().value)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
