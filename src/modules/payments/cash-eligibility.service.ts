import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import { toPaise } from './payments.money';
import { PAYMENT_SETTINGS } from './payments.types';

export interface CashOfferDecision {
  allowed: boolean;
  /** Present when `allowed` is false — safe to show a customer. */
  reason?: string;
  code?: string;
}

/**
 * The two gates on cash, and the ceiling that stops it accumulating.
 *
 * Feature 11 requires **both** gates to be enforced server-side, which is the
 * point: a client that decided this for itself could book cash anywhere, and
 * `Booking.paymentMode` is frozen at creation, so the wrong answer is
 * permanent for that booking.
 */
@Injectable()
export class CashEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * May this service, in this city, be booked as cash?
   *
   * The city gate is a `PlatformSetting`, so ops can close cash in a city
   * during an incident without a deploy. The service gate is a column, added
   * by this module against CONFLICTS_AND_DECISIONS #13 — see #37.
   */
  async canOfferCash(input: {
    serviceId: string;
    cityId?: string | null;
  }): Promise<CashOfferDecision> {
    const enabled = await this.settings.getString(
      PAYMENT_SETTINGS.cashEnabled,
      'true',
      input.cityId,
    );

    if (enabled !== 'true') {
      return {
        allowed: false,
        reason: 'Cash payment is not available in this city right now',
        code: 'CASH_DISABLED_FOR_CITY',
      };
    }

    const service = await this.prisma.service.findUnique({
      where: { id: input.serviceId },
      select: { allowsCash: true },
    });

    if (service && !service.allowsCash) {
      return {
        allowed: false,
        reason: 'This service must be paid for online',
        code: 'CASH_DISABLED_FOR_SERVICE',
      };
    }

    return { allowed: true };
  }

  /** Rupees a Pro may carry before cash work stops reaching them. */
  ceiling(cityId?: string | null): Promise<number> {
    return this.settings.getNumber(
      PAYMENT_SETTINGS.cashCeiling,
      10_000,
      cityId,
    );
  }

  /**
   * Feature 16 — Pros who have breached the ceiling and must hand over before
   * they are offered another cash job.
   *
   * Returned as a list of ids so module 5 can exclude them with a single
   * `where` clause rather than asking per candidate. **It excludes them from
   * cash bookings only.** Blocking a Pro's online work as well would punish
   * them for carrying cash the platform asked them to carry.
   */
  async blockedProIds(cityId?: string | null): Promise<string[]> {
    const ceiling = await this.ceiling(cityId);

    const blocked = await this.prisma.pro.findMany({
      where: { cashInHand: { gt: ceiling } },
      select: { id: true },
    });

    return blocked.map((pro) => pro.id);
  }

  /** Whether one specific Pro may take one more cash job. */
  async isProBlocked(proId: string, cityId?: string | null): Promise<boolean> {
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      select: { cashInHand: true },
    });
    if (!pro) return false;

    const ceiling = await this.ceiling(cityId);
    return toPaise(pro.cashInHand.toString()) > toPaise(ceiling.toFixed(2));
  }
}
