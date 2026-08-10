import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Reads `PlatformSetting`, with the city override the ERD describes: a row
 * scoped to a city wins over the global default for that city.
 *
 * Module 14 owns this table and will eventually own an admin API for it. This
 * is a **read-only** accessor so module 4 can honour the cross-cutting rule —
 * "no magic numbers; every tunable lives in PlatformSetting" — without waiting
 * for module 14 or hard-coding the cancellation fee, the grace window and the
 * payment hold in the code that uses them.
 */
@Injectable()
export class PlatformSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getNumber(
    key: string,
    fallback: number,
    cityId?: string | null,
  ): Promise<number> {
    const raw = await this.getString(key, null, cityId);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    // A malformed setting must not take the whole flow down with a NaN that
    // silently propagates into money or a deadline.
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  async getString(
    key: string,
    fallback: string | null,
    cityId?: string | null,
  ): Promise<string | null> {
    if (cityId) {
      const scoped = await this.prisma.platformSetting.findFirst({
        where: { key, cityId },
      });
      if (scoped) return scoped.value;
    }

    const global = await this.prisma.platformSetting.findFirst({
      where: { key, cityId: null },
    });
    return global?.value ?? fallback;
  }
}
