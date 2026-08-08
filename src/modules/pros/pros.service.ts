import {
  HttpStatus,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import type { Pro, Prisma } from '../../prisma/client';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditLogService } from '../identity/services/audit-log.service';
import { TokenService } from '../identity/services/token.service';
import { AdminUpdateProProfileDto } from './dto/admin-update-pro-profile.dto';
import { IngestLocationDto } from './dto/ingest-location.dto';
import { UpdateProDto } from './dto/update-pro.dto';

const PRO_LIVE_GEO_KEY = 'pros:live';

@Injectable()
export class ProsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly auditLog: AuditLogService,
    private readonly tokenService: TokenService,
  ) {}

  async getById(id: string): Promise<Pro> {
    const pro = await this.prisma.pro.findUnique({ where: { id } });
    if (!pro) throw new NotFoundException('Pro not found');
    return pro;
  }

  async update(id: string, dto: UpdateProDto): Promise<Pro> {
    await this.getById(id);
    return this.prisma.pro.update({ where: { id }, data: dto });
  }

  /**
   * Admin-only fields — city assignment and the recorded (reference-only)
   * monthly salary. Kept separate from update() (the Pro's own self-edit
   * path) since neither field should ever be Pro-editable.
   */
  async updateProfileByAdmin(
    id: string,
    dto: AdminUpdateProProfileDto,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<Pro> {
    const before = await this.getById(id);

    if (dto.cityId) {
      const city = await this.prisma.city.findUnique({
        where: { id: dto.cityId },
      });
      if (!city)
        throw apiError('cityId does not exist', HttpStatus.BAD_REQUEST);
    }

    const updated = await this.prisma.pro.update({
      where: { id },
      data: {
        ...(dto.cityId ? { cityId: dto.cityId } : {}),
        ...(dto.monthlySalary !== undefined
          ? { monthlySalary: dto.monthlySalary, salaryUpdatedAt: new Date() }
          : {}),
      },
    });

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: 'pro.profile.update',
      entityType: 'Pro',
      entityId: id,
      before: { cityId: before.cityId, monthlySalary: before.monthlySalary },
      after: { cityId: updated.cityId, monthlySalary: updated.monthlySalary },
      ipAddress,
    });

    return updated;
  }

  /**
   * Live position into Redis GEO (what dispatch will query), plus an
   * immediate cold flush to Pro.lastKnownLat/Lng — simplest correct version
   * of "periodic cold flush" until a real background job exists.
   */
  async ingestLocation(id: string, dto: IngestLocationDto): Promise<void> {
    await this.redis.geoAdd(PRO_LIVE_GEO_KEY, dto.lng, dto.lat, id);
    await this.prisma.pro.update({
      where: { id },
      data: {
        lastKnownLat: dto.lat,
        lastKnownLng: dto.lng,
        lastLocationAt: new Date(),
      },
    });
  }

  async findMany(
    filters: {
      cityId?: string;
      isAvailable?: boolean;
      status?: string;
    },
    allowedCityIds?: string[],
  ): Promise<Pro[]> {
    const where: Prisma.ProWhereInput = {
      ...(filters.cityId
        ? { cityId: filters.cityId }
        : allowedCityIds?.length
          ? { cityId: { in: allowedCityIds } }
          : {}),
      ...(filters.isAvailable !== undefined
        ? { isAvailable: filters.isAvailable }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };

    return this.prisma.pro.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async setAvailability(
    id: string,
    isAvailable: boolean,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<Pro> {
    const before = await this.getById(id);

    const updated = await this.prisma.pro.update({
      where: { id },
      data: { isAvailable, availabilityUpdatedAt: new Date() },
    });

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: 'pro.availability.set',
      entityType: 'Pro',
      entityId: id,
      before: { isAvailable: before.isAvailable },
      after: { isAvailable: updated.isAvailable },
      ipAddress,
    });

    return updated;
  }

  async bulkSetAvailability(
    proIds: string[],
    isAvailable: boolean,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<Pro[]> {
    const results: Pro[] = [];
    for (const id of proIds) {
      results.push(
        await this.setAvailability(id, isAvailable, actingAdminId, ipAddress),
      );
    }
    return results;
  }

  async suspend(
    id: string,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<Pro> {
    const pro = await this.getById(id);
    if (pro.status !== 'approved') {
      throw apiError(
        `Cannot suspend a Pro with status "${pro.status}"`,
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.pro.update({
      where: { id },
      data: { status: 'suspended' },
    });

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: 'pro.suspend',
      entityType: 'Pro',
      entityId: id,
      before: { status: pro.status },
      after: { status: updated.status },
      ipAddress,
    });
    await this.tokenService.revokeAllSessions('pro', id);

    return updated;
  }

  async reinstate(
    id: string,
    actingAdminId: string,
    ipAddress: string | null,
  ): Promise<Pro> {
    const pro = await this.getById(id);
    if (pro.status !== 'suspended') {
      throw apiError(
        `Cannot reinstate a Pro with status "${pro.status}"`,
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.pro.update({
      where: { id },
      data: { status: 'approved' },
    });

    await this.auditLog.record({
      adminUserId: actingAdminId,
      action: 'pro.reinstate',
      entityType: 'Pro',
      entityId: id,
      before: { status: pro.status },
      after: { status: updated.status },
      ipAddress,
    });

    return updated;
  }

  /**
   * Kept here (rather than the applications service) since it mutates Pro
   * directly. Sequence-backed so concurrent approvals can't hand out the
   * same code — see the initial Prisma migration for pro_employee_code_seq.
   */
  async generateEmployeeCode(): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ nextval: bigint }[]>`
      SELECT nextval('pro_employee_code_seq') AS nextval
    `;
    return `HG-${rows[0].nextval.toString().padStart(5, '0')}`;
  }

  assertDigilockerNotSupported(source: string): void {
    if (source === 'digilocker') {
      throw new NotImplementedException(
        'DigiLocker integration is not wired up yet — submit this document with source: manual',
      );
    }
  }
}
