import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { HistoryQueryDto } from './dto/history-query.dto';
import { ProStandingDto } from './dto/pro-standing.dto';

@Injectable()
export class ProStandingService {
  constructor(private readonly prisma: PrismaService) {}

  async standing(proId: string): Promise<ProStandingDto> {
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      select: {
        cityId: true,
        ratingSum: true,
        ratingCount: true,
        assignmentsOffered: true,
        assignmentsAcknowledged: true,
        acceptanceRate: true,
        completedJobs: true,
        countersRebuiltAt: true,
      },
    });
    if (!pro) throw new NotFoundException('Pro not found');

    const settings = await this.prisma.platformSetting.findMany({
      where: {
        key: {
          in: ['dispatch.ratingPriorMean', 'dispatch.ratingPriorWeight'],
        },
        OR: [{ cityId: null }, ...(pro.cityId ? [{ cityId: pro.cityId }] : [])],
      },
      orderBy: { cityId: 'asc' },
    });
    const valueFor = (key: string, fallback: number) => {
      const setting =
        settings.find((row) => row.key === key && row.cityId === pro.cityId) ??
        settings.find((row) => row.key === key && row.cityId === null);
      const parsed = Number(setting?.value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const priorMean = valueFor('dispatch.ratingPriorMean', 4);
    const priorWeight = valueFor('dispatch.ratingPriorWeight', 5);
    const ratingAverage =
      pro.ratingCount === 0 ? null : pro.ratingSum / pro.ratingCount;
    const smoothedRatingScore =
      (pro.ratingSum + priorMean * priorWeight) /
      (pro.ratingCount + priorWeight);

    return {
      ratingAverage,
      ratingCount: pro.ratingCount,
      smoothedRatingScore,
      ratingAffectsDispatch: true,
      assignmentsOffered: pro.assignmentsOffered,
      assignmentsAcknowledged: pro.assignmentsAcknowledged,
      acceptanceRate: pro.acceptanceRate,
      acceptanceRatePercent:
        pro.acceptanceRate === null ? null : pro.acceptanceRate * 100,
      acceptanceAffectsDispatch: false,
      acceptanceAffectsPay: false,
      completedJobs: pro.completedJobs,
      countersRebuiltAt: pro.countersRebuiltAt,
    };
  }

  async jobs(proId: string, query: HistoryQueryDto) {
    const { skip, take } = this.page(query);
    const where = { proId };
    const [data, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        select: {
          id: true,
          bookingNumber: true,
          serviceId: true,
          status: true,
          assignedAt: true,
          arrivedAt: true,
          startedAt: true,
          completedAt: true,
          actualDurationMinutes: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.booking.count({ where }),
    ]);
    return { data, meta: this.meta(query, total) };
  }

  async ratings(proId: string, query: HistoryQueryDto) {
    const { skip, take } = this.page(query);
    const where = { proId };
    const [rows, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        select: {
          id: true,
          bookingId: true,
          rating: true,
          comment: true,
          tags: true,
          isHidden: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.review.count({ where }),
    ]);
    const data = rows.map(({ isHidden, ...row }) => ({
      ...row,
      comment: isHidden ? null : row.comment,
      tags: isHidden ? [] : row.tags,
      contentHidden: isHidden,
    }));
    return { data, meta: this.meta(query, total) };
  }

  async earnings(proId: string, query: HistoryQueryDto) {
    const computedAt = this.dateRange(query);
    const groups = await this.prisma.bookingCommission.groupBy({
      by: ['status'],
      where: { proId, ...(computedAt ? { computedAt } : {}) },
      _sum: {
        commissionAmount: true,
        incentiveAmount: true,
        deductionAmount: true,
        netPayable: true,
      },
      _count: { _all: true },
    });
    return {
      basis: 'commission_only',
      salaryIncluded: false,
      from: query.from ?? null,
      to: query.to ?? null,
      byStatus: groups.map((group) => ({
        status: group.status,
        count: group._count._all,
        commissionAmount: group._sum.commissionAmount?.toString() ?? '0',
        incentiveAmount: group._sum.incentiveAmount?.toString() ?? '0',
        deductionAmount: group._sum.deductionAmount?.toString() ?? '0',
        netPayable: group._sum.netPayable?.toString() ?? '0',
      })),
    };
  }

  async commissions(proId: string, query: HistoryQueryDto) {
    const { skip, take } = this.page(query);
    const computedAt = this.dateRange(query);
    const where = { proId, ...(computedAt ? { computedAt } : {}) };
    const [data, total] = await Promise.all([
      this.prisma.bookingCommission.findMany({
        where,
        orderBy: { computedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.bookingCommission.count({ where }),
    ]);
    return { data, meta: this.meta(query, total) };
  }

  async payouts(proId: string, query: HistoryQueryDto) {
    const { skip, take } = this.page(query);
    const where = { proId };
    const [data, total] = await Promise.all([
      this.prisma.commissionPayout.findMany({
        where,
        include: { _count: { select: { commissions: true } } },
        orderBy: { periodEnd: 'desc' },
        skip,
        take,
      }),
      this.prisma.commissionPayout.count({ where }),
    ]);
    return { data, meta: this.meta(query, total) };
  }

  async payout(proId: string, payoutId: string) {
    const payout = await this.prisma.commissionPayout.findFirst({
      where: { id: payoutId, proId },
      include: { commissions: { orderBy: { computedAt: 'asc' } } },
    });
    if (!payout) throw new NotFoundException('Payout not found');
    return payout;
  }

  private page(query: HistoryQueryDto) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    return { skip: (page - 1) * take, take };
  }

  private meta(query: HistoryQueryDto, total: number) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  private dateRange(query: HistoryQueryDto) {
    if (!query.from && !query.to) return null;
    return {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }
}
