import { UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';

function buildDeps() {
  const jwt = {
    signAsync: jest.fn((payload: object) =>
      Promise.resolve(JSON.stringify(payload)),
    ),
    verifyAsync: jest.fn((token: string) => Promise.resolve(JSON.parse(token))),
  };
  const redis = {
    set: jest.fn(),
    get: jest.fn().mockResolvedValue('1'),
    del: jest.fn(),
    delByPattern: jest.fn(),
  };
  const config = {
    get: jest.fn((_name: string, fallback: string) => fallback),
  };
  const prisma = {
    customer: { findUnique: jest.fn() },
    pro: { findUnique: jest.fn() },
    adminUser: { findUnique: jest.fn() },
  };
  const service = new TokenService(
    jwt as never,
    redis as never,
    config as never,
    prisma as never,
  );
  return { service, jwt, redis, prisma };
}

describe('TokenService', () => {
  it('creates independent refresh sessions for multiple devices', async () => {
    const { service, redis } = buildDeps();
    await service.issueTokenPair({ id: 'c1', actorType: 'customer' });
    await service.issueTokenPair({ id: 'c1', actorType: 'customer' });
    const keys = redis.set.mock.calls.map((call) => call[0] as string);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('reloads an admin role and city scope during refresh', async () => {
    const { service, jwt, prisma } = buildDeps();
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'a1',
      roleId: 'new-role',
      cityScopeJson: ['indore'],
      isActive: true,
    });
    const pair = await service.issueTokenPair({
      id: 'a1',
      actorType: 'admin',
      roleId: 'old-role',
    });
    await service.rotateRefreshToken(pair.refreshToken);
    expect(jwt.signAsync.mock.calls[2][0]).toEqual(
      expect.objectContaining({ roleId: 'new-role' }),
    );
  });

  it('revokes all sessions when a blocked customer refreshes', async () => {
    const { service, redis, prisma } = buildDeps();
    prisma.customer.findUnique.mockResolvedValue({ id: 'c1', isBlocked: true });
    const pair = await service.issueTokenPair({
      id: 'c1',
      actorType: 'customer',
    });
    await expect(service.rotateRefreshToken(pair.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(redis.delByPattern).toHaveBeenCalledWith('session:customer:c1:*');
  });
});
