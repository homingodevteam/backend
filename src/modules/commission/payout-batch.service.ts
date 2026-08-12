import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { CommissionPayout } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { fromPaise, toPaise } from '../payments/payments.money';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import { sumRupees } from './commission-calculator';
import { COMMISSION_SETTINGS } from './commission.types';
import { DeductionsService } from './deductions.service';
import { payoutPeriod } from './incentive-periods';

export interface SkippedPro {
  proId: string;
  proName: string;
  reason: string;
  code: string;
  /** What they would have been paid, so ops can see the size of the problem. */
  withheldAmount: string;
}

export interface BatchResult {
  periodStart: string;
  periodEnd: string;
  created: number;
  totalNet: string;
  skipped: SkippedPro[];
}

/**
 * Feature 11 — one payout per Pro per period, aggregating commission,
 * incentives and deductions.
 *
 * ## What a period actually means
 *
 * `periodStart` and `periodEnd` **label** a batch. They are not the inclusion
 * filter, and the difference matters more than it looks.
 *
 * The obvious rule — "every commission whose job completed inside these dates"
 * — orphans money. A job completed on the 28th, held behind a dispute, and
 * approved on the 3rd falls outside August's batch because it was not approved
 * in time, and outside September's because it did not complete in September. It
 * is then never paid by any batch, forever, and nothing reports it.
 *
 * So the rule is: **every `approved`, unpaid commission belonging to this Pro as
 * of `periodEnd`**, whenever it was earned. Late arrivals fall into the next
 * batch instead of falling through the floor. `periodStart` remains on the row
 * because a Pro reading "1–31 August" understands what they are looking at, and
 * because the statement has to say something.
 *
 * The rule is deterministic in the sense that matters: running the same
 * generation twice produces the same batches, and no commission can appear in
 * two of them, because being attached to one sets `payoutId` and stops it being
 * unpaid.
 */
@Injectable()
export class PayoutBatchService {
  private readonly logger = new Logger(PayoutBatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly deductions: DeductionsService,
  ) {}

  /**
   * Build draft payouts for a period.
   *
   * Safe to re-run: a commission already attached to a batch is no longer
   * unpaid, so a second generation over the same period finds nothing and
   * creates nothing. That is what makes this callable from a cron without a
   * lock table.
   */
  async generate(input: {
    periodEnd?: string;
    periodDays?: number;
    cityId?: string;
  }): Promise<BatchResult> {
    const endAt = input.periodEnd ? new Date(input.periodEnd) : new Date();
    if (Number.isNaN(endAt.getTime())) {
      throw apiError('periodEnd is not a valid date', HttpStatus.BAD_REQUEST);
    }

    const periodDays =
      input.periodDays ??
      (await this.settings.getNumber(
        COMMISSION_SETTINGS.PAYOUT_PERIOD_DAYS,
        30,
        input.cityId,
      ));

    const minimumNet = await this.settings.getString(
      COMMISSION_SETTINGS.PAYOUT_MINIMUM_NET,
      '0',
      input.cityId,
    );

    const { start, end } = payoutPeriod(endAt, periodDays);

    // Every Pro with something owed as of the period end — not every Pro who
    // worked in the window. See the class comment.
    const candidates = await this.prisma.bookingCommission.groupBy({
      by: ['proId'],
      where: {
        status: 'approved',
        payoutId: null,
        reversedAt: null,
        computedAt: { lt: end },
        ...(input.cityId ? { pro: { cityId: input.cityId } } : {}),
      },
    });

    const skipped: SkippedPro[] = [];
    const netAmounts: string[] = [];
    let created = 0;

    for (const candidate of candidates) {
      const outcome = await this.buildOne({
        proId: candidate.proId,
        periodStart: start,
        periodEnd: endAt,
        cutoff: end,
        minimumNet: minimumNet ?? '0',
      });

      if (outcome.skipped) {
        skipped.push(outcome.skipped);
      } else if (outcome.payout) {
        created += 1;
        netAmounts.push(outcome.payout.netAmount.toString());
      }
    }

    if (skipped.length > 0) {
      // Loud on purpose. Every name on this list is somebody who worked and is
      // not about to be paid, and a silently shorter batch looks like success.
      this.logger.warn(
        `Payout generation skipped ${skipped.length} Pro(s): ` +
          skipped.map((row) => `${row.proName} (${row.code})`).join(', '),
      );
    }

    return {
      periodStart: start.toISOString(),
      periodEnd: endAt.toISOString(),
      created,
      totalNet: sumRupees(netAmounts),
      skipped,
    };
  }

  private async buildOne(input: {
    proId: string;
    periodStart: Date;
    periodEnd: Date;
    cutoff: Date;
    minimumNet: string;
  }): Promise<{ payout?: CommissionPayout; skipped?: SkippedPro }> {
    const pro = await this.prisma.pro.findUnique({
      where: { id: input.proId },
      select: {
        id: true,
        fullName: true,
        phone: true,
        status: true,
        bankAccounts: {
          where: { isPrimary: true, isVerified: true },
          take: 1,
        },
      },
    });
    if (!pro) return {};
    // `Pro.fullName` is nullable — it is copied from the KYC application and
    // may not be there yet. The phone always is, and a skipped-Pro list that
    // says "null" is a list ops cannot act on.
    const proName = pro.fullName ?? pro.phone;

    return this.prisma.$transaction(async (tx) => {
      // Serialises two generations racing on the same Pro, which would
      // otherwise each claim the same commission rows.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payout:${input.proId}`}, 0))`;

      const rows = await tx.bookingCommission.findMany({
        where: {
          proId: input.proId,
          status: 'approved',
          payoutId: null,
          reversedAt: null,
          computedAt: { lt: input.cutoff },
        },
        select: {
          id: true,
          commissionAmount: true,
          incentiveAmount: true,
        },
      });
      if (rows.length === 0) return {};

      // Summed from the two earning columns, NOT from `netPayable`. That column
      // already has per-job deductions taken off it for display, and deductions
      // are really consumed below — adding both would take every deduction
      // twice.
      const commissionAmount = sumRupees(
        rows.map((row) => row.commissionAmount.toString()),
      );
      const incentiveAmount = sumRupees(
        rows.map((row) => row.incentiveAmount.toString()),
      );
      const gross = sumRupees([commissionAmount, incentiveAmount]);

      const consumption = await this.deductions.planConsumption(
        input.proId,
        gross,
        tx,
      );

      // `sumRupees` deliberately has no notion of a negative operand — every
      // other total in this module is a sum of positives, and letting one of
      // them go negative is how a payout would become a bank debit. The single
      // subtraction in the module is done here, in paise, explicitly.
      const netPaise = toPaise(gross) - toPaise(consumption.total);
      const netAmount = fromPaise(netPaise);

      const bankAccount = pro.bankAccounts[0];
      if (!bankAccount) {
        return {
          skipped: {
            proId: pro.id,
            proName,
            reason:
              'No verified primary bank account. Their earnings stay unpaid and roll into the next period.',
            code: 'NO_VERIFIED_BANK_ACCOUNT',
            withheldAmount: gross,
          },
        };
      }

      /**
       * A verified bank account is not the same as a payable one.
       *
       * `accountNumberMasked` is masked before it ever reaches this server —
       * the DTO rejects anything else — so the platform has never held a
       * number a bank transfer could be sent to. The only destinations that
       * exist are a UPI id, or a RazorpayX fund account somebody registered
       * out of band. See CONFLICTS_AND_DECISIONS #51.
       *
       * Caught **here** rather than at `disburse`, which is where it used to
       * surface. A Pro with a verified account and no UPI id passed generation
       * silently, sat in the finance queue looking correct, got approved, and
       * failed at the transfer — the single worst moment to discover it. Now
       * they appear in `skipped` beside everyone else who is not getting paid.
       */
      if (!bankAccount.upiId && !bankAccount.razorpayxFundAccountId) {
        return {
          skipped: {
            proId: pro.id,
            proName,
            reason:
              'Their bank account number is stored masked and they have no UPI id, so there is nowhere to send the money. Add a UPI id to make them payable.',
            code: 'NO_PAYABLE_DESTINATION',
            withheldAmount: gross,
          },
        };
      }

      if (netPaise < toPaise(input.minimumNet)) {
        return {
          skipped: {
            proId: pro.id,
            proName,
            reason: `Net ${netAmount} is below the minimum payout of ${input.minimumNet}. Rolled into the next period.`,
            code: 'BELOW_MINIMUM_NET',
            withheldAmount: netAmount,
          },
        };
      }

      const payout = await tx.commissionPayout.create({
        data: {
          proId: pro.id,
          bankAccountId: bankAccount.id,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          commissionAmount,
          incentiveAmount,
          deductionAmount: consumption.total,
          netAmount,
          status: 'draft',
        },
      });

      await tx.bookingCommission.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { payoutId: payout.id },
      });

      /**
       * Deductions are claimed here rather than at disbursement, and released
       * again if the batch is rejected. Waiting until the money moved would let
       * the next generation take the same debt a second time.
       *
       * **A row a batch cannot afford whole is split, not partly claimed.** The
       * temptation is to leave `consumedAmount` sitting at ₹2,000 of ₹5,000 and
       * move on — but `consumedByPayoutId` is a single column, so the next
       * batch to take a bite overwrites it, and rejecting either batch then has
       * no way to know how much *it* took. Splitting keeps every row owned by
       * exactly one payout, which makes the release below exact.
       */
      for (const line of consumption.lines) {
        const current = await tx.payoutDeduction.findUnique({
          where: { id: line.deductionId },
        });
        if (!current) continue;

        if (!line.fullyConsumed) {
          const remainder =
            toPaise(current.amount.toString()) - toPaise(line.taken);
          await tx.payoutDeduction.create({
            data: {
              proId: current.proId,
              amount: fromPaise(remainder),
              kind: current.kind,
              reason: `${current.reason} (₹${fromPaise(remainder)} carried forward)`,
              sourceCommissionId: current.sourceCommissionId,
              // The original keeps the dedupe key. A remainder is not a second
              // reversal, and giving it a key of its own would break the
              // exactly-once guarantee the column exists for.
              dedupeKey: null,
              raisedByAdminId: current.raisedByAdminId,
            },
          });
        }

        await tx.payoutDeduction.update({
          where: { id: line.deductionId },
          data: {
            amount: line.taken,
            consumedAmount: line.taken,
            consumedByPayoutId: payout.id,
            fullyConsumedAt: new Date(),
          },
        });
      }

      return { payout };
    });
  }

  /**
   * Finance says the batch is right.
   *
   * A conditional `updateMany` rather than a read-then-write: two admins
   * clicking approve at the same moment must produce one approval, and the
   * `where` clause is what decides it rather than whichever read happened
   * first.
   */
  async approve(payoutId: string, adminId: string): Promise<CommissionPayout> {
    const { count } = await this.prisma.commissionPayout.updateMany({
      where: { id: payoutId, status: 'draft' },
      data: {
        status: 'approved',
        approvedByAdminId: adminId,
        approvedAt: new Date(),
      },
    });

    if (count === 0) {
      await this.assertExists(payoutId);
      throw apiError(
        'Only a draft payout can be approved',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: 'This payout has already moved past draft',
            code: 'PAYOUT_NOT_DRAFT',
          },
        ],
      );
    }

    return this.getOrFail(payoutId);
  }

  /**
   * Send a batch back, releasing everything it was holding.
   *
   * Both halves matter. The commissions go back to `approved` and unattached so
   * the next generation picks them up; the deductions give back exactly what
   * this batch took, so a rejected batch does not quietly forgive a debt.
   */
  async reject(
    payoutId: string,
    reason: string,
    adminId: string,
  ): Promise<CommissionPayout> {
    return this.prisma.$transaction(async (tx) => {
      const payout = await tx.commissionPayout.findUnique({
        where: { id: payoutId },
        include: { deductions: true },
      });
      if (!payout) throw apiError('Payout not found', HttpStatus.NOT_FOUND);

      if (payout.status !== 'draft' && payout.status !== 'approved') {
        throw apiError(
          'Only a draft or approved payout can be rejected',
          HttpStatus.CONFLICT,
          [
            {
              field: 'status',
              message: `A ${payout.status} payout cannot be sent back`,
              code: 'PAYOUT_NOT_REVERSIBLE',
            },
          ],
        );
      }

      await tx.bookingCommission.updateMany({
        where: { payoutId },
        data: { payoutId: null },
      });

      for (const deduction of payout.deductions) {
        if (toPaise(deduction.consumedAmount.toString()) === 0) continue;

        await tx.payoutDeduction.update({
          where: { id: deduction.id },
          data: {
            // Exact, because of the split rule above: this batch is the only
            // thing that ever claimed this row, and it claimed all of it. Any
            // part it could not afford already left as a separate row and is
            // untouched here.
            consumedAmount: '0',
            consumedByPayoutId: null,
            fullyConsumedAt: null,
          },
        });
      }

      return tx.commissionPayout.update({
        where: { id: payoutId },
        data: {
          status: 'rejected',
          failureReason: reason,
          approvedByAdminId: adminId,
          approvedAt: new Date(),
        },
      });
    });
  }

  async getOrFail(payoutId: string): Promise<CommissionPayout> {
    const payout = await this.prisma.commissionPayout.findUnique({
      where: { id: payoutId },
    });
    if (!payout) throw apiError('Payout not found', HttpStatus.NOT_FOUND);
    return payout;
  }

  private async assertExists(payoutId: string): Promise<void> {
    await this.getOrFail(payoutId);
  }
}
