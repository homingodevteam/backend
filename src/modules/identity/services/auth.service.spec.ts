import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

function buildDeps() {
  const otpProvider = {
    sendOtp: jest.fn(),
    verifyOtp: jest.fn(),
  };
  const tokenService = {
    issueTokenPair: jest.fn().mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
    }),
    rotateRefreshToken: jest.fn(),
    revokeSession: jest.fn(),
    revokeAllSessions: jest.fn(),
  };
  const redis = {
    incrWithExpiry: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    adminUser: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    customer: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    pro: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };

  return { otpProvider, tokenService, redis, prisma };
}

function buildService(deps: ReturnType<typeof buildDeps>): AuthService {
  return new AuthService(
    deps.otpProvider,
    deps.tokenService as never,
    deps.redis as never,
    deps.prisma as never,
  );
}

describe('AuthService', () => {
  describe('requestOtp', () => {
    it('rejects once the rate limit is exceeded', async () => {
      const deps = buildDeps();
      deps.redis.incrWithExpiry.mockResolvedValue(6);
      const service = buildService(deps);

      await expect(
        service.requestOtp({ phone: '+919876543210', actorType: 'customer' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(deps.otpProvider.sendOtp).not.toHaveBeenCalled();
    });

    it('never sends an OTP to an unregistered admin phone', async () => {
      const deps = buildDeps();
      deps.prisma.adminUser.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(
        service.requestOtp({ phone: '+919876543210', actorType: 'admin' }),
      ).rejects.toThrow(NotFoundException);
      expect(deps.otpProvider.sendOtp).not.toHaveBeenCalled();
    });

    it('sends the OTP for a valid customer/pro request', async () => {
      const deps = buildDeps();
      deps.otpProvider.sendOtp.mockResolvedValue({ providerRef: 'ref-1' });
      const service = buildService(deps);

      const result = await service.requestOtp({
        phone: '+919876543210',
        actorType: 'customer',
      });

      expect(result).toEqual({ providerRef: 'ref-1' });
      expect(deps.otpProvider.sendOtp).toHaveBeenCalledWith('+919876543210');
    });
  });

  describe('verifyOtp', () => {
    it('rejects an invalid or expired code before touching the database', async () => {
      const deps = buildDeps();
      deps.otpProvider.verifyOtp.mockResolvedValue(false);
      const service = buildService(deps);

      await expect(
        service.verifyOtp({
          phone: '+919876543210',
          code: '000000',
          providerRef: 'ref-1',
          actorType: 'customer',
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(deps.prisma.customer.findUnique).not.toHaveBeenCalled();
    });

    it('upgrades a guest customer in place, preserving the id', async () => {
      const deps = buildDeps();
      deps.otpProvider.verifyOtp.mockResolvedValue(true);
      deps.prisma.customer.findUnique
        .mockResolvedValueOnce(null) // no verified customer at this phone yet
        .mockResolvedValueOnce({
          id: 'guest-id-1',
          status: 'guest',
          isBlocked: false,
        }); // the guest row for this deviceId
      deps.prisma.customer.update.mockResolvedValue({
        id: 'guest-id-1',
        status: 'verified',
        isBlocked: false,
      });
      const service = buildService(deps);

      await service.verifyOtp({
        phone: '+919876543210',
        code: '123456',
        providerRef: 'ref-1',
        actorType: 'customer',
        deviceId: 'device-1',
      });

      expect(deps.prisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'guest-id-1' } }),
      );
      expect(deps.prisma.customer.create).not.toHaveBeenCalled();
      expect(deps.tokenService.issueTokenPair).toHaveBeenCalledWith({
        id: 'guest-id-1',
        actorType: 'customer',
      });
    });

    it('rejects a blocked customer even with a valid code', async () => {
      const deps = buildDeps();
      deps.otpProvider.verifyOtp.mockResolvedValue(true);
      deps.prisma.customer.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'verified',
        isBlocked: true,
      });
      const service = buildService(deps);

      await expect(
        service.verifyOtp({
          phone: '+919876543210',
          code: '123456',
          providerRef: 'ref-1',
          actorType: 'customer',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a suspended Pro', async () => {
      const deps = buildDeps();
      deps.otpProvider.verifyOtp.mockResolvedValue(true);
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'suspended',
      });
      const service = buildService(deps);

      await expect(
        service.verifyOtp({
          phone: '+919876543210',
          code: '123456',
          providerRef: 'ref-1',
          actorType: 'pro',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('creates a new Pro with status "applied" on first login', async () => {
      const deps = buildDeps();
      deps.otpProvider.verifyOtp.mockResolvedValue(true);
      deps.prisma.pro.findUnique.mockResolvedValue(null);
      deps.prisma.pro.create.mockResolvedValue({ id: 'p2', status: 'applied' });
      const service = buildService(deps);

      await service.verifyOtp({
        phone: '+919876543210',
        code: '123456',
        providerRef: 'ref-1',
        actorType: 'pro',
      });

      expect(deps.prisma.pro.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'applied' }),
        }),
      );
    });

    it('never auto-creates an admin — 404 if the phone is unregistered', async () => {
      const deps = buildDeps();
      deps.otpProvider.verifyOtp.mockResolvedValue(true);
      deps.prisma.adminUser.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(
        service.verifyOtp({
          phone: '+919876543210',
          code: '123456',
          providerRef: 'ref-1',
          actorType: 'admin',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(deps.prisma.adminUser.update).not.toHaveBeenCalled();
    });
  });
});
