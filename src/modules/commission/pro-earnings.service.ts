import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import { fromPaise, toPaise } from '../payments/payments.money';
import { sumRupees } from './commission-calculator';
import { COMMISSION_SETTINGS } from './commission.types';
import { DeductionsService } from './deductions.service';
import { payoutPeriod, startOfIstDay } from './incentive-periods';

type Decimal = Prisma.Decimal;

/**
 * Feature 9 — the Pro's live earnings view.
 *
 * "Updates as jobs complete, no end-of-day wait" is satisfied by these being
 * plain reads of `BookingCommission`, which the completion hook writes
 * synchronously. There is no cache and no nightly roll-up to fall behind, which
 * is the only way "live" survives contact with a background job.
 *
 * **Everything here is commission and incentives only.** The Pro is a salaried
 * employee and payroll pays the salary; a screen that implies otherwise turns a
 * partial number into a wrong one. `salaryNote` exists so the app cannot forget
 * to say so.
 */
@Injectable()
export class ProEarningsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly deductions: DeductionsService,
  ) {}

  async summary(proId: string, now = new Date()) {
    const periodDays = await this.settings.getNumber(
      COMMISSION_SETTINGS.PAYOUT_PERIOD_DAYS,
      30,
    );
    const { start: periodStart } = payoutPeriod(now, periodDays);
    const dayStart = startOfIstDay(now);

    // `reversed` is excluded everywhere below. A reversed job did not earn
    // anything, and leaving it in "lifetime" to keep the number flattering
    // would make the total disagree with the statement behind it.
    const earning = { proId, status: { not: 'reversed' as const } };

    const [today, period, lifetime, unpaid, lastPayout, outstanding] =
      await Promise.all([
        this.prisma.bookingCommission.aggregate({
          where: { ...earning, computedAt: { gte: dayStart } },
          _sum: { commissionAmount: true, incentiveAmount: true },
          _count: true,
        }),
        this.prisma.bookingCommission.aggregate({
          where: { ...earning, computedAt: { gte: periodStart } },
          _sum: { commissionAmount: true, incentiveAmount: true },
          _count: true,
        }),
        this.prisma.bookingCommission.aggregate({
          where: earning,
          _sum: { commissionAmount: true, incentiveAmount: true },
          _count: true,
        }),
        this.prisma.bookingCommission.aggregate({
          where: { ...earning, status: { in: ['pending', 'approved'] } },
          _sum: { commissionAmount: true, incentiveAmount: true },
        }),
        this.prisma.commissionPayout.findFirst({
          where: { proId, status: 'paid' },
          orderBy: { paidAt: 'desc' },
          select: {
            id: true,
            netAmount: true,
            paidAt: true,
            periodStart: true,
            periodEnd: true,
          },
        }),
        this.deductions.outstandingTotal(proId),
      ]);

    const bucket = (row: {
      _sum: {
        commissionAmount: Decimal | null;
        incentiveAmount: Decimal | null;
      };
      _count?: number;
    }) => {
      const commission = (row._sum.commissionAmount ?? '0').toString();
      const incentives = (row._sum.incentiveAmount ?? '0').toString();
      return {
        jobs: row._count ?? 0,
        commission: sumRupees([commission]),
        incentives: sumRupees([incentives]),
        total: sumRupees([commission, incentives]),
      };
    };

    const unpaidBucket = bucket(unpaid);
    // What is actually going to arrive: everything earned and not yet paid,
    // less what is owed back. Never negative — a deduction bigger than the
    // balance waits rather than turning into a debt the app displays.
    const unpaidNet = Math.max(
      0,
      toPaise(unpaidBucket.total) - toPaise(outstanding),
    );

    return {
      today: bucket(today),
      period: {
        ...bucket(period),
        start: periodStart,
        end: now,
      },
      lifetime: bucket(lifetime),
      unpaidEarnings: unpaidBucket.total,
      pendingDeductions: outstanding,
      unpaidBalance: fromPaise(unpaidNet),
      lastPayout: lastPayout
        ? {
            id: lastPayout.id,
            netAmount: lastPayout.netAmount.toString(),
            paidAt: lastPayout.paidAt,
            periodStart: lastPayout.periodStart,
            periodEnd: lastPayout.periodEnd,
          }
        : null,
      salaryNote:
        'Commission and incentives only. Your salary is paid separately by payroll.',
    };
  }

  /** Job-by-job earnings. The statement behind the summary. */
  async commissions(
    proId: string,
    query: {
      page?: number;
      limit?: number;
      from?: string;
      to?: string;
      status?: string;
    },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      proId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            computedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.bookingCommission.count({ where }),
      this.prisma.bookingCommission.findMany({
        where,
        include: {
          booking: {
            select: {
              bookingNumber: true,
              completedAt: true,
              service: { select: { name: true } },
            },
          },
        },
        orderBy: { computedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      page,
      limit,
      total,
      items: rows.map((row) => this.toLine(row)),
    };
  }

  /** One job, in full — including which rate was used to pay it. */
  toLine(row: {
    id: string;
    status: string;
    computedAt: Date;
    customerFlatAmount: { toString(): string };
    commissionType: string;
    commissionValue: { toString(): string };
    commissionAmount: { toString(): string };
    incentiveAmount: { toString(): string };
    deductionAmount: { toString(): string };
    netPayable: { toString(): string };
    actualDurationMinutes: number | null;
    reversedAt: Date | null;
    reversalReason: string | null;
    payoutId: string | null;
    booking: {
      bookingNumber: string;
      completedAt: Date | null;
      service: { name: string };
    };
  }) {
    return {
      id: row.id,
      bookingNumber: row.booking.bookingNumber,
      serviceName: row.booking.service.name,
      completedAt: row.booking.completedAt,
      computedAt: row.computedAt,
      status: row.status,
      customerPaid: row.customerFlatAmount.toString(),
      /**
       * The snapshotted rate, shown deliberately. A Pro who can see the rate
       * their job was actually paid at can check the arithmetic, and can tell
       * a rate change apart from an error — which is the whole practical point
       * of snapshotting (US-8.3).
       */
      rate: {
        type: row.commissionType,
        value: row.commissionValue.toString(),
      },
      earned: row.commissionAmount.toString(),
      incentive: row.incentiveAmount.toString(),
      deduction: row.deductionAmount.toString(),
      netPayable: row.netPayable.toString(),
      // Reporting only, and labelled as such so nobody reads it as an input.
      durationMinutes: row.actualDurationMinutes,
      reversedAt: row.reversedAt,
      reversalReason: row.reversalReason,
      payoutId: row.payoutId,
    };
  }

  /** US-8.14 — a deduction the Pro can query is recoverable; a debit is not. */
  async deductionStatement(proId: string) {
    const rows = await this.prisma.payoutDeduction.findMany({
      where: { proId, waivedAt: null },
      include: {
        sourceCommission: {
          select: { booking: { select: { bookingNumber: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      outstandingTotal: await this.deductions.outstandingTotal(proId),
      items: rows.map((row) => ({
        id: row.id,
        amount: row.amount.toString(),
        recovered: row.consumedAmount.toString(),
        kind: row.kind,
        reason: row.reason,
        bookingNumber: row.sourceCommission?.booking.bookingNumber ?? null,
        raisedAt: row.createdAt,
        settledAt: row.fullyConsumedAt,
        payoutId: row.consumedByPayoutId,
      })),
    };
  }

  /** US-8.12 — payout history. Readable while suspended. */
  async payouts(proId: string, query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [total, rows] = await Promise.all([
      this.prisma.commissionPayout.count({ where: { proId } }),
      this.prisma.commissionPayout.findMany({
        where: { proId },
        orderBy: { periodEnd: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      page,
      limit,
      total,
      items: rows.map((row) => this.toPayout(row)),
    };
  }

  async payout(proId: string, payoutId: string) {
    const row = await this.prisma.commissionPayout.findUnique({
      where: { id: payoutId },
    });
    if (!row || row.proId !== proId) return null;
    return this.toPayout(row);
  }

  /** US-8.12 — "what did this ₹8,400 cover?" */
  async payoutCommissions(proId: string, payoutId: string) {
    const payout = await this.prisma.commissionPayout.findUnique({
      where: { id: payoutId },
    });
    if (!payout || payout.proId !== proId) return null;

    const [rows, deductions] = await Promise.all([
      this.prisma.bookingCommission.findMany({
        where: { payoutId },
        include: {
          booking: {
            select: {
              bookingNumber: true,
              completedAt: true,
              service: { select: { name: true } },
            },
          },
        },
        orderBy: { computedAt: 'asc' },
      }),
      this.prisma.payoutDeduction.findMany({
        where: { consumedByPayoutId: payoutId },
      }),
    ]);

    return {
      payout: this.toPayout(payout),
      jobs: rows.map((row) => this.toLine(row)),
      deductions: deductions.map((row) => ({
        id: row.id,
        amount: row.consumedAmount.toString(),
        kind: row.kind,
        reason: row.reason,
      })),
    };
  }

  private toPayout(row: {
    id: string;
    periodStart: Date;
    periodEnd: Date;
    commissionAmount: { toString(): string };
    incentiveAmount: { toString(): string };
    deductionAmount: { toString(): string };
    netAmount: { toString(): string };
    status: string;
    paidAt: Date | null;
    payoutReference: string | null;
    payoutMode: string | null;
  }) {
    return {
      id: row.id,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      commissionAmount: row.commissionAmount.toString(),
      incentiveAmount: row.incentiveAmount.toString(),
      deductionAmount: row.deductionAmount.toString(),
      netAmount: row.netAmount.toString(),
      status: row.status,
      paidAt: row.paidAt,
      /**
       * The bank's own reference, so a Pro comparing this screen to their
       * passbook has something to match on. `failureReason` is deliberately
       * NOT here — it is RazorpayX's text, written for whoever reads their
       * dashboard, and the Pro's honest version is the status.
       */
      reference: row.payoutReference,
      mode: row.payoutMode,
    };
  }
}
