import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { RecurringPlan } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ServiceCatalogService } from '../catalog/service-catalog.service';
import { CustomersService } from '../customers/customers.service';
import { BookingsService } from './bookings.service';
import {
  CreateRecurringPlanDto,
  UpdateRecurringPlanDto,
} from './dto/recurring-plan.dto';
import { PlatformSettingsService } from './platform-settings.service';

const DAY_MS = 86_400_000;

/**
 * Standing orders that generate bookings ahead of time.
 *
 * **Each occurrence is priced when it is generated, not when the plan was
 * made** — the catalogue rate of that moment. That is the documented default
 * and the only reading consistent with US-3.5 (a price change applies to
 * future bookings). It also means a customer's weekly price can move without
 * them acting, which Notifications should tell them about.
 */
@Injectable()
export class RecurringPlansService {
  private readonly logger = new Logger(RecurringPlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly catalog: ServiceCatalogService,
    private readonly customers: CustomersService,
    private readonly settings: PlatformSettingsService,
  ) {}

  async create(
    customerId: string,
    dto: CreateRecurringPlanDto,
  ): Promise<RecurringPlan> {
    const address = await this.customers.getAddressForCustomer(
      customerId,
      dto.addressId,
    );
    const service = await this.catalog.assertBookable(dto.serviceId);

    if (!service.supportsRecurring) {
      throw apiError(
        'This service cannot be booked on a recurring plan',
        HttpStatus.CONFLICT,
        [
          {
            field: 'serviceId',
            message: 'Service does not support recurring booking',
            code: 'RECURRING_UNSUPPORTED',
          },
        ],
      );
    }

    const needsDays =
      dto.frequency === 'weekly' || dto.frequency === 'biweekly';
    if (needsDays && !dto.daysOfWeek?.length) {
      throw apiError(
        'Pick at least one day of the week',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'daysOfWeek',
            message: `Required for ${dto.frequency} plans`,
            code: 'DAYS_OF_WEEK_REQUIRED',
          },
        ],
      );
    }

    if (dto.endDate && dto.endDate < dto.startDate) {
      throw apiError(
        'The end date is before the start date',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.recurringPlan.create({
      data: {
        customerId,
        serviceId: service.id,
        addressId: address.id,
        frequency: dto.frequency,
        daysOfWeek: dto.daysOfWeek ?? [],
        timeOfDay: dto.timeOfDay,
        startDate: dto.startDate,
        endDate: dto.endDate ?? null,
        nextRunAt: dto.startDate,
        isActive: true,
      },
    });
  }

  list(customerId: string): Promise<RecurringPlan[]> {
    return this.prisma.recurringPlan.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(
    customerId: string,
    planId: string,
    dto: UpdateRecurringPlanDto,
  ): Promise<RecurringPlan> {
    await this.getOwnedPlan(customerId, planId);

    return this.prisma.recurringPlan.update({
      where: { id: planId },
      data: {
        ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
        ...(dto.timeOfDay === undefined ? {} : { timeOfDay: dto.timeOfDay }),
        ...(dto.daysOfWeek === undefined ? {} : { daysOfWeek: dto.daysOfWeek }),
        ...(dto.endDate === undefined ? {} : { endDate: dto.endDate }),
      },
    });
  }

  /**
   * Generates every occurrence that has come due.
   *
   * Deliberately tolerant: one plan failing — a service retired since, an
   * address deleted — must not stop the others. **A failure never deactivates
   * the plan**, because US-4.3 is explicit that silently losing a weekly
   * cleaner to one bad occurrence is a churn event.
   *
   * Called by a scheduled job once module 12 exists; exposed as an admin route
   * meanwhile so it can be driven and tested.
   */
  async generateDueBookings(now = new Date()): Promise<{
    generated: number;
    skipped: number;
  }> {
    const aheadDays = await this.settings.getNumber(
      'booking.recurringGenerateAheadDays',
      3,
    );
    const horizon = new Date(now.getTime() + aheadDays * DAY_MS);

    const due = await this.prisma.recurringPlan.findMany({
      where: {
        isActive: true,
        nextRunAt: { not: null, lte: horizon },
        OR: [{ endDate: null }, { endDate: { gte: now } }],
      },
      take: 500,
    });

    let generated = 0;
    let skipped = 0;

    for (const plan of due) {
      try {
        await this.generateOne(plan);
        generated += 1;
      } catch (error) {
        skipped += 1;
        this.logger.error(
          `Recurring plan ${plan.id}: occurrence not generated`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return { generated, skipped };
  }

  private async generateOne(plan: RecurringPlan): Promise<void> {
    if (!plan.nextRunAt) return;

    // Priced here, at the catalogue rate of this moment — not the plan's.
    const booking = await this.bookings.create(plan.customerId, {
      serviceId: plan.serviceId,
      addressId: plan.addressId,
      paymentMode: 'cash',
      slotStartAt: plan.nextRunAt,
    });

    const nextRunAt = this.advance(plan, plan.nextRunAt);
    const exhausted = plan.endDate !== null && nextRunAt > plan.endDate;

    await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: booking.id },
        data: { bookingType: 'recurring', recurringPlanId: plan.id },
      }),
      this.prisma.recurringPlan.update({
        where: { id: plan.id },
        data: {
          nextRunAt: exhausted ? null : nextRunAt,
          // The plan reaching its own end date is the one legitimate reason to
          // stop — never a failed occurrence.
          isActive: !exhausted,
        },
      }),
    ]);
  }

  /** The next due instant after `from`, per the plan's frequency. */
  private advance(plan: RecurringPlan, from: Date): Date {
    switch (plan.frequency) {
      case 'daily':
        return new Date(from.getTime() + DAY_MS);
      case 'weekly':
        return new Date(from.getTime() + 7 * DAY_MS);
      case 'biweekly':
        return new Date(from.getTime() + 14 * DAY_MS);
      case 'monthly': {
        // Calendar month, not 30 days — the 15th stays the 15th. A plan on the
        // 31st lands on the last day of a shorter month rather than skipping it.
        const next = new Date(from);
        const targetDay = next.getUTCDate();
        next.setUTCMonth(next.getUTCMonth() + 1, 1);
        const daysInMonth = new Date(
          Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
        ).getUTCDate();
        next.setUTCDate(Math.min(targetDay, daysInMonth));
        return next;
      }
      default:
        return new Date(from.getTime() + 7 * DAY_MS);
    }
  }

  private async getOwnedPlan(
    customerId: string,
    planId: string,
  ): Promise<RecurringPlan> {
    const plan = await this.prisma.recurringPlan.findUnique({
      where: { id: planId },
    });
    if (!plan || plan.customerId !== customerId) {
      throw apiError('Recurring plan not found', HttpStatus.NOT_FOUND);
    }
    return plan;
  }
}
