import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Incentive, Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  hasEvaluator,
  type IncentiveRecurrence,
  type IncentiveType,
} from './commission.types';
import type {
  CreateIncentiveDto,
  UpdateIncentiveDto,
} from './dto/incentive.dto';
import { averageRating, parseCriteria } from './incentive-evaluators';
import { periodFor } from './incentive-periods';

export interface IncentiveView extends Incentive {
  /**
   * False for `streak` and `surge_slot`. Surfaced on **every** read, not just
   * at creation, because an admin who scrolls past the warning once must still
   * see the scheme is inert every time they look at it.
   */
  hasEvaluator: boolean;
}

/**
 * Feature 7's admin half — configuring bonus schemes.
 *
 * The evaluation half is `IncentiveEvaluationService`. Kept apart because they
 * have opposite risk profiles: this one is CRUD an admin drives, that one runs
 * unattended on every completion.
 */
@Injectable()
export class IncentivesService {
  private readonly logger = new Logger(IncentivesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateIncentiveDto,
    adminId: string,
  ): Promise<IncentiveView> {
    // Throws on a shape the evaluator could not read. Validating here rather
    // than at evaluation time is the difference between an admin seeing the
    // problem now and a Pro not being paid a bonus in six weeks' time.
    parseCriteria(dto.incentiveType, dto.criteriaJson);

    const validFrom = new Date(dto.validFrom);
    const validTo = dto.validTo ? new Date(dto.validTo) : null;
    if (validTo && validTo <= validFrom) {
      throw apiError(
        'validTo must be after validFrom',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'validTo',
            message: 'The window must be a window',
            code: 'INCENTIVE_WINDOW_INVALID',
          },
        ],
      );
    }

    if (dto.cityId) {
      const city = await this.prisma.city.findUnique({
        where: { id: dto.cityId },
      });
      if (!city) throw apiError('City not found', HttpStatus.NOT_FOUND);
    }

    const created = await this.prisma.incentive.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        incentiveType: dto.incentiveType,
        recurrence: dto.recurrence ?? 'once',
        criteriaJson: dto.criteriaJson as Prisma.InputJsonValue,
        rewardAmount: dto.rewardAmount,
        cityId: dto.cityId ?? null,
        validFrom,
        validTo,
        createdByAdminId: adminId,
      },
    });

    if (!hasEvaluator(created.incentiveType)) {
      this.logger.warn(
        `Incentive "${created.name}" is of type ${created.incentiveType}, which has no ` +
          'evaluator. It will track nothing and pay nobody until the rules for ' +
          'that type are defined and built.',
      );
    }

    return this.decorate(created);
  }

  async update(id: string, dto: UpdateIncentiveDto): Promise<IncentiveView> {
    const existing = await this.getOrFail(id);

    const incentiveType = (dto.incentiveType ??
      existing.incentiveType) as IncentiveType;
    const criteriaJson = dto.criteriaJson ?? existing.criteriaJson;
    parseCriteria(incentiveType, criteriaJson);
    // `Incentive.criteriaJson` is NOT NULL, so the update input excludes
    // `JsonNull` — but Prisma types the *read* side as possibly null, which is
    // what makes the round trip need a cast rather than an assertion of fact.
    const criteria = criteriaJson as Prisma.InputJsonValue;

    const updated = await this.prisma.incentive.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.description === undefined
          ? {}
          : { description: dto.description }),
        ...(dto.incentiveType === undefined ? {} : { incentiveType }),
        ...(dto.recurrence === undefined ? {} : { recurrence: dto.recurrence }),
        ...(dto.criteriaJson === undefined ? {} : { criteriaJson: criteria }),
        ...(dto.rewardAmount === undefined
          ? {}
          : { rewardAmount: dto.rewardAmount }),
        ...(dto.validTo === undefined
          ? {}
          : { validTo: dto.validTo ? new Date(dto.validTo) : null }),
      },
    });

    /**
     * Nothing here touches `ProIncentiveProgress`.
     *
     * A bonus already credited keeps the reward that was snapshotted onto it,
     * for the same reason a completed job keeps its commission rate: raising
     * the reward must not retroactively top up March, and lowering it must not
     * quietly take money back. Runs still in progress pick up the new figures
     * on their next evaluation, which is the only place a change can fairly
     * apply.
     */
    return this.decorate(updated);
  }

  /**
   * Stop a scheme crediting anything further.
   *
   * Deactivation, never deletion. A bonus already earned points at this row
   * from `ProIncentiveProgress`, and removing it would leave a Pro's statement
   * saying they were paid ₹2,000 for a reason nobody can name.
   */
  async deactivate(id: string): Promise<IncentiveView> {
    await this.getOrFail(id);
    const updated = await this.prisma.incentive.update({
      where: { id },
      data: { isActive: false },
    });
    return this.decorate(updated);
  }

  async list(filter: {
    isActive?: boolean;
    incentiveType?: string;
    cityId?: string;
  }): Promise<IncentiveView[]> {
    const rows = await this.prisma.incentive.findMany({
      where: {
        ...(filter.isActive === undefined ? {} : { isActive: filter.isActive }),
        ...(filter.incentiveType
          ? { incentiveType: filter.incentiveType }
          : {}),
        ...(filter.cityId ? { cityId: filter.cityId } : {}),
      },
      orderBy: [{ isActive: 'desc' }, { validFrom: 'desc' }],
    });
    return rows.map((row) => this.decorate(row));
  }

  async getOne(id: string): Promise<IncentiveView> {
    return this.decorate(await this.getOrFail(id));
  }

  /** Who has won this scheme and who is close. Paged. */
  async progress(
    id: string,
    query: { page?: number; limit?: number; achieved?: boolean },
  ) {
    await this.getOrFail(id);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      incentiveId: id,
      ...(query.achieved === undefined
        ? {}
        : query.achieved
          ? { achievedAt: { not: null } }
          : { achievedAt: null }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.proIncentiveProgress.count({ where }),
      this.prisma.proIncentiveProgress.findMany({
        where,
        include: {
          pro: { select: { id: true, fullName: true, phone: true } },
          _count: { select: { contributions: true } },
        },
        orderBy: [{ achievedAt: 'desc' }, { progressValue: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      page,
      limit,
      total,
      items: rows.map((row) => ({
        proId: row.proId,
        proName: row.pro.fullName ?? row.pro.phone,
        periodKey: row.periodKey,
        progressValue: row.progressValue.toString(),
        targetValue: row.targetValue.toString(),
        contributingJobs: row._count.contributions,
        averageRating: averageRating({
          contributionCount: row._count.contributions,
          progressValue: row.progressValue.toString(),
        }),
        achievedAt: row.achievedAt,
        rewardCredited: row.rewardCredited,
        rewardAmount: row.rewardAmount?.toString() ?? null,
      })),
    };
  }

  /**
   * What a Pro sees: the schemes open to them right now, with their own
   * progress in the current period.
   *
   * Unevaluated types are **excluded** rather than shown at zero. Advertising a
   * bonus in the app that the platform has no way to credit is the one failure
   * mode US-8.7's open question makes likely, and a Pro chasing a streak that
   * nothing is counting is worse than a Pro who never saw it.
   */
  async forPro(proId: string, at: Date) {
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      select: { cityId: true },
    });
    if (!pro) throw apiError('Pro not found', HttpStatus.NOT_FOUND);

    const incentives = await this.prisma.incentive.findMany({
      where: {
        isActive: true,
        validFrom: { lte: at },
        OR: [{ validTo: null }, { validTo: { gt: at } }],
        ...(pro.cityId
          ? { AND: [{ OR: [{ cityId: null }, { cityId: pro.cityId }] }] }
          : { cityId: null }),
      },
      orderBy: { validFrom: 'desc' },
    });

    const visible = incentives.filter((row) => hasEvaluator(row.incentiveType));
    if (visible.length === 0) return [];

    const progressRows = await this.prisma.proIncentiveProgress.findMany({
      where: { proId, incentiveId: { in: visible.map((row) => row.id) } },
      include: { _count: { select: { contributions: true } } },
    });

    return visible.map((incentive) => {
      const period = periodFor(incentive.recurrence as IncentiveRecurrence, at);
      const progress = progressRows.find(
        (row) =>
          row.incentiveId === incentive.id && row.periodKey === period.key,
      );

      const contributionCount = progress?._count.contributions ?? 0;
      const progressValue = progress?.progressValue.toString() ?? '0.00';

      return {
        id: incentive.id,
        name: incentive.name,
        description: incentive.description,
        incentiveType: incentive.incentiveType,
        recurrence: incentive.recurrence,
        rewardAmount: incentive.rewardAmount.toString(),
        periodKey: period.key,
        periodEndsAt: period.end,
        progressValue,
        targetValue: progress?.targetValue.toString() ?? null,
        contributingJobs: contributionCount,
        ...(incentive.incentiveType === 'rating'
          ? {
              averageRating: averageRating({
                contributionCount,
                progressValue,
              }),
            }
          : {}),
        achievedAt: progress?.achievedAt ?? null,
        rewardCredited: progress?.rewardCredited ?? false,
      };
    });
  }

  private async getOrFail(id: string): Promise<Incentive> {
    const row = await this.prisma.incentive.findUnique({ where: { id } });
    if (!row) throw apiError('Incentive not found', HttpStatus.NOT_FOUND);
    return row;
  }

  private decorate(row: Incentive): IncentiveView {
    return { ...row, hasEvaluator: hasEvaluator(row.incentiveType) };
  }
}
