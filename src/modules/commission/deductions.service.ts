import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { PayoutDeduction, Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { fromPaise, toPaise } from '../payments/payments.money';
import { consumeAgainst, sumRupees } from './commission-calculator';
import type { DeductionKind } from './commission.types';

/**
 * What is left on a deduction row.
 *
 * Its own named function rather than an expression inline, because it is asked
 * in two places and getting it backwards is silent: the wrong operand order
 * returns zero for every row, which reads as "this Pro owes nothing" instead of
 * as an error.
 */
function stillOwed(row: {
  amount: { toString(): string };
  consumedAmount: { toString(): string };
}): string {
  return fromPaise(
    toPaise(row.amount.toString()) - toPaise(row.consumedAmount.toString()),
  );
}

/**
 * Money owed back to the platform, and the one rule that governs all of it:
 * **it is never taken out of a Pro's bank account.**
 *
 * US-8.13 and US-8.14 are emphatic about this, and the reason is practical
 * rather than sentimental. A visible deduction the Pro can query is
 * recoverable — they can read it, argue with it, and have it waived. A surprise
 * debit is a dispute, a support ticket, and in India frequently a bounced
 * mandate. So there is no code path anywhere in this module that debits
 * anything; there is only this table, and the batch that consumes it.
 */
@Injectable()
export class DeductionsService {
  private readonly logger = new Logger(DeductionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Raise a deduction, at most once per `dedupeKey`.
   *
   * The unique index on `dedupeKey` is what makes "the same reversal cannot
   * deduct twice" a database guarantee. Catching the conflict and returning the
   * existing row — rather than letting it throw — is what makes a retried
   * reversal safe: the caller gets the same answer the first call got.
   */
  async raise(input: {
    proId: string;
    amount: string;
    kind: DeductionKind;
    reason: string;
    sourceCommissionId?: string | null;
    dedupeKey?: string | null;
    raisedByAdminId?: string | null;
    tx?: Prisma.TransactionClient;
  }): Promise<PayoutDeduction | null> {
    if (toPaise(input.amount) <= 0) return null;

    const client = input.tx ?? this.prisma;

    if (input.dedupeKey) {
      const existing = await client.payoutDeduction.findUnique({
        where: { dedupeKey: input.dedupeKey },
      });
      if (existing) {
        this.logger.log(
          `Deduction ${input.dedupeKey} already exists — not raising a second one.`,
        );
        return existing;
      }
    }

    try {
      return await client.payoutDeduction.create({
        data: {
          proId: input.proId,
          amount: input.amount,
          kind: input.kind,
          reason: input.reason,
          sourceCommissionId: input.sourceCommissionId ?? null,
          dedupeKey: input.dedupeKey ?? null,
          raisedByAdminId: input.raisedByAdminId ?? null,
        },
      });
    } catch (error) {
      // Two concurrent reversals of the same job. The index did its job; the
      // right answer is the row that won, not an error.
      if (
        input.dedupeKey &&
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'P2002'
      ) {
        return client.payoutDeduction.findUnique({
          where: { dedupeKey: input.dedupeKey },
        });
      }
      throw error;
    }
  }

  /**
   * What this Pro still owes: raised, not waived, not fully consumed.
   *
   * Oldest first, because a debt that keeps being skipped in favour of newer
   * ones never settles.
   */
  outstandingFor(
    proId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PayoutDeduction[]> {
    return (tx ?? this.prisma).payoutDeduction.findMany({
      where: { proId, waivedAt: null, fullyConsumedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** The unconsumed remainder across every outstanding row. */
  async outstandingTotal(proId: string): Promise<string> {
    const rows = await this.outstandingFor(proId);
    return sumRupees(rows.map((row) => stillOwed(row)));
  }

  /**
   * Take what a payout can afford out of the outstanding rows, oldest first.
   *
   * **Partial by design.** A ₹5,000 recovery against a ₹2,000 period takes
   * ₹2,000 now and leaves ₹3,000 on the row for next time. The alternatives are
   * both wrong: consuming rows only when they fit whole means a large debt
   * stalls forever, and consuming the lot means a negative payout, which is a
   * bank debit wearing a different name.
   *
   * Returns what was taken and the rows it came from, so the caller can write
   * `consumedByPayoutId` inside its own transaction.
   */
  async planConsumption(
    proId: string,
    available: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    total: string;
    lines: { deductionId: string; taken: string; fullyConsumed: boolean }[];
  }> {
    const rows = await this.outstandingFor(proId, tx);

    let remaining = available;
    const lines: {
      deductionId: string;
      taken: string;
      fullyConsumed: boolean;
    }[] = [];

    for (const row of rows) {
      if (toPaise(remaining) === 0) break;

      const { taken, remainingOwed, remainingAvailable } = consumeAgainst(
        remaining,
        stillOwed(row),
      );
      if (toPaise(taken) === 0) continue;

      lines.push({
        deductionId: row.id,
        taken,
        fullyConsumed: toPaise(remainingOwed) === 0,
      });
      remaining = remainingAvailable;
    }

    return { total: sumRupees(lines.map((line) => line.taken)), lines };
  }

  /**
   * Forgive what is left of a deduction.
   *
   * Only the unconsumed part can be waived: the consumed part has already
   * reduced a payout that has already been sent, and "un-taking" it here would
   * leave the books saying the Pro was paid an amount they were not.
   */
  async waive(
    deductionId: string,
    reason: string,
    adminId: string,
  ): Promise<PayoutDeduction> {
    const row = await this.prisma.payoutDeduction.findUnique({
      where: { id: deductionId },
    });
    if (!row) throw apiError('Deduction not found', HttpStatus.NOT_FOUND);

    if (row.waivedAt) {
      throw apiError(
        'This deduction has already been waived',
        HttpStatus.CONFLICT,
      );
    }
    if (row.fullyConsumedAt) {
      throw apiError(
        'This deduction has already been taken from a payout and cannot be waived',
        HttpStatus.CONFLICT,
        [
          {
            field: 'consumedByPayoutId',
            message: 'Already recovered in full',
            code: 'DEDUCTION_ALREADY_CONSUMED',
          },
        ],
      );
    }

    return this.prisma.payoutDeduction.update({
      where: { id: deductionId },
      data: {
        waivedAt: new Date(),
        waiveReason: reason,
        waivedByAdminId: adminId,
      },
    });
  }
}
