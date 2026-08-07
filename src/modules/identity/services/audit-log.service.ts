import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

interface RecordAuditParams {
  adminUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  /** Prisma model instances (Date/Decimal fields included) are fine here. */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/**
 * Every admin-mutating endpoint calls record() once. Exported from
 * IdentityModule so CustomersModule and ProsModule (and everything after
 * them) can log without owning their own copy of this table.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(params: RecordAuditParams): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: {
        adminUserId: params.adminUserId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        beforeJson: toJsonSafe(params.before),
        afterJson: toJsonSafe(params.after),
        ipAddress: params.ipAddress ?? null,
      },
    });
  }
}

/**
 * Callers pass Prisma model instances directly (`{ ...updated }`), which
 * carry real `Date`/`Decimal` values — neither is a valid Prisma.InputJsonValue.
 * Round-tripping through JSON turns Dates into ISO strings the same way
 * `JSON.stringify` always has, which is exactly what belongs in a jsonb
 * audit column anyway.
 */
function toJsonSafe(
  value: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (value == null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
