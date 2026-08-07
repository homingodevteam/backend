import { NotImplementedException } from '@nestjs/common';
import { ProApplicationsService } from './pro-applications.service';

function buildDeps() {
  const prisma = {
    proApplication: {
      findMany: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    pro: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  const prosService = {
    assertDigilockerNotSupported: jest.fn((source: string) => {
      if (source === 'digilocker') {
        throw new NotImplementedException('not supported');
      }
    }),
    generateEmployeeCode: jest.fn().mockResolvedValue('HG-00001'),
  };
  const auditLog = { record: jest.fn() };

  return { prisma, prosService, auditLog };
}

function buildService(
  deps: ReturnType<typeof buildDeps>,
): ProApplicationsService {
  return new ProApplicationsService(
    deps.prisma as never,
    deps.prosService as never,
    deps.auditLog as never,
  );
}

describe('ProApplicationsService', () => {
  describe('submit', () => {
    it('rejects a digilocker source — not integrated yet', async () => {
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.submit('pro-1', {
          aadhaarSource: 'digilocker',
          panSource: 'manual',
          panUrl: 'kyc/pro-1/pan/abc',
        }),
      ).rejects.toThrow(NotImplementedException);
      expect(deps.prisma.proApplication.create).not.toHaveBeenCalled();
    });

    it('requires aadhaarUrl when the source is manual', async () => {
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.submit('pro-1', {
          aadhaarSource: 'manual',
          panSource: 'manual',
          panUrl: 'kyc/pro-1/pan/abc',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 400 }),
      });
    });

    it('creates the application and pushes the Pro back under review', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.create.mockResolvedValue({ id: 'app-1' });
      const service = buildService(deps);

      await service.submit('pro-1', {
        aadhaarSource: 'manual',
        aadhaarUrl: 'kyc/pro-1/aadhaar/abc',
        panSource: 'manual',
        panUrl: 'kyc/pro-1/pan/abc',
      });

      expect(deps.prisma.pro.update).toHaveBeenCalledWith({
        where: { id: 'pro-1' },
        data: { status: 'under_review' },
      });
    });
  });

  describe('decide', () => {
    it('refuses to approve unless both documents are verified', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        aadhaarStatus: 'verified',
        panStatus: 'pending',
      });
      const service = buildService(deps);

      await expect(
        service.decide('app-1', { decision: 'approved' }, 'admin-1', null),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 409 }),
      });
      expect(deps.prisma.proApplication.update).not.toHaveBeenCalled();
    });

    it('requires a reason when rejecting', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        aadhaarStatus: 'pending',
        panStatus: 'pending',
      });
      const service = buildService(deps);

      await expect(
        service.decide('app-1', { decision: 'rejected' }, 'admin-1', null),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ statusCode: 400 }),
      });
    });

    it('approves, sets the Pro to approved, and generates an employee code', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        aadhaarStatus: 'verified',
        panStatus: 'verified',
      });
      deps.prisma.proApplication.update.mockResolvedValue({
        id: 'app-1',
        decision: 'approved',
      });
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'pro-1',
        employeeCode: null,
      });
      const service = buildService(deps);

      await service.decide(
        'app-1',
        { decision: 'approved' },
        'admin-1',
        '1.2.3.4',
      );

      expect(deps.prosService.generateEmployeeCode).toHaveBeenCalled();
      expect(deps.prisma.pro.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pro-1' },
          data: expect.objectContaining({
            status: 'approved',
            approvedApplicationId: 'app-1',
            employeeCode: 'HG-00001',
          }),
        }),
      );
    });

    it('keeps an existing employee code rather than generating a new one', async () => {
      const deps = buildDeps();
      deps.prisma.proApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        proId: 'pro-1',
        aadhaarStatus: 'verified',
        panStatus: 'verified',
      });
      deps.prisma.proApplication.update.mockResolvedValue({
        id: 'app-1',
        decision: 'approved',
      });
      deps.prisma.pro.findUnique.mockResolvedValue({
        id: 'pro-1',
        employeeCode: 'HG-00042',
      });
      const service = buildService(deps);

      await service.decide('app-1', { decision: 'approved' }, 'admin-1', null);

      expect(deps.prosService.generateEmployeeCode).not.toHaveBeenCalled();
      expect(deps.prisma.pro.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ employeeCode: 'HG-00042' }),
        }),
      );
    });
  });
});
