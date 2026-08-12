import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { fromPaise, toPaise } from '../payments/payments.money';
import { startOfIstDay } from '../commission/incentive-periods';
import { ACCOUNT } from './ledger.types';

/**
 * Which way an account grows.
 *
 * Standard double-entry: assets and expenses increase on the debit side,
 * liabilities and revenue on the credit side. Getting this backwards does not
 * throw — it silently reports every balance negated — so it is one function
 * with one test rather than a sign flipped by hand at each call site.
 */
const DEBIT_NORMAL_PREFIXES = [
  'gateway:',
  'bank:',
  'cash_in_hand:',
  'expense:',
] as const;

export function isDebitNormal(account: string): boolean {
  return DEBIT_NORMAL_PREFIXES.some((prefix) => account.startsWith(prefix));
}

export interface AccountBalance {
  account: string;
  debits: string;
  credits: string;
  /** Signed by the account's normal side, so a healthy figure reads positive. */
  balance: string;
}

/**
 * "Daily collections, payouts due and outstanding dues answered as queries over
 * the ledger" — feature 8, and it is genuinely a query rather than a table
 * because the entries are already there.
 *
 * Nothing here is cached. Every number is a `groupBy` over an indexed column at
 * a volume measured in thousands of rows, and a cached financial total is a
 * number that can disagree with the books.
 */
@Injectable()
export class LedgerBalancesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Balances for every account, or for the ones matching a prefix.
   *
   * Two `groupBy` calls rather than one: an entry names two accounts, and
   * Postgres cannot group by both at once. They are merged in memory, which is
   * fine — the number of distinct accounts is small and bounded by the number
   * of Pros.
   */
  async balances(prefix?: string): Promise<AccountBalance[]> {
    const [debits, credits] = await Promise.all([
      this.prisma.ledgerEntry.groupBy({
        by: ['debitAccount'],
        _sum: { amount: true },
        ...(prefix ? { where: { debitAccount: { startsWith: prefix } } } : {}),
      }),
      this.prisma.ledgerEntry.groupBy({
        by: ['creditAccount'],
        _sum: { amount: true },
        ...(prefix ? { where: { creditAccount: { startsWith: prefix } } } : {}),
      }),
    ]);

    const totals = new Map<string, { debits: number; credits: number }>();
    const bucket = (account: string) => {
      const existing = totals.get(account);
      if (existing) return existing;
      const fresh = { debits: 0, credits: 0 };
      totals.set(account, fresh);
      return fresh;
    };

    for (const row of debits) {
      bucket(row.debitAccount).debits += toPaise(
        (row._sum.amount ?? '0').toString(),
      );
    }
    for (const row of credits) {
      bucket(row.creditAccount).credits += toPaise(
        (row._sum.amount ?? '0').toString(),
      );
    }

    return [...totals.entries()]
      .map(([account, sums]) => ({
        account,
        debits: fromPaise(sums.debits),
        credits: fromPaise(sums.credits),
        balance: fromPaise(
          isDebitNormal(account)
            ? sums.debits - sums.credits
            : sums.credits - sums.debits,
        ),
      }))
      .sort((a, b) => a.account.localeCompare(b.account));
  }

  /** One account, without pulling the whole set. */
  async balanceOf(account: string): Promise<string> {
    const [debits, credits] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({
        where: { debitAccount: account },
        _sum: { amount: true },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: { creditAccount: account },
        _sum: { amount: true },
      }),
    ]);

    const d = toPaise((debits._sum.amount ?? '0').toString());
    const c = toPaise((credits._sum.amount ?? '0').toString());
    return fromPaise(isDebitNormal(account) ? d - c : c - d);
  }

  /**
   * Feature 9 — what came in today, what is owed out, and where the cash is.
   *
   * Three questions a finance lead actually asks, answered from the entries.
   * The **variance trend** the feature list also names is deliberately absent:
   * it needs a history of reconciliation runs that does not exist yet, and a
   * trend line over two data points is a decoration.
   */
  async dashboard(now = new Date()) {
    const dayStart = startOfIstDay(now);

    const [
      collectedToday,
      refundedToday,
      grossRevenue,
      refunds,
      recoveries,
      commissionExpense,
      incentiveExpense,
      owedOut,
      cashOnStreet,
      gateway,
      bank,
    ] = await Promise.all([
      this.sum({
        creditAccount: ACCOUNT.REVENUE_BOOKINGS,
        entryDate: { gte: dayStart },
      }),
      this.sum({
        debitAccount: ACCOUNT.REVENUE_BOOKINGS,
        entryDate: { gte: dayStart },
      }),
      this.sum({ creditAccount: ACCOUNT.REVENUE_BOOKINGS }),
      this.sum({ debitAccount: ACCOUNT.REVENUE_BOOKINGS }),
      this.sum({ creditAccount: ACCOUNT.REVENUE_RECOVERIES }),
      this.balanceOf(ACCOUNT.EXPENSE_COMMISSION),
      this.balanceOf(ACCOUNT.EXPENSE_INCENTIVES),
      this.balances('payable:pro:'),
      this.balances('cash_in_hand:'),
      this.balanceOf(ACCOUNT.GATEWAY),
      this.balanceOf(ACCOUNT.BANK),
    ]);

    const netRevenue = toPaise(grossRevenue) - toPaise(refunds);

    return {
      today: {
        collected: collectedToday,
        refunded: refundedToday,
        net: fromPaise(toPaise(collectedToday) - toPaise(refundedToday)),
      },
      allTime: {
        grossRevenue,
        refunds,
        recoveries,
        commissionExpense,
        incentiveExpense,
        /**
         * The `platform_revenue` the ERD names as an entry type, computed
         * instead of stored — one figure that cannot disagree with the entries
         * behind it, rather than two that can.
         */
        platformRevenue: fromPaise(
          netRevenue +
            toPaise(recoveries) -
            toPaise(commissionExpense) -
            toPaise(incentiveExpense),
        ),
      },
      owedToPros: this.total(owedOut),
      cashHeldByPros: this.total(cashOnStreet),
      heldAtGateway: gateway,
      inBank: bank,
      prosOwed: owedOut.filter((row) => toPaise(row.balance) !== 0).length,
      prosHoldingCash: cashOnStreet.filter((row) => toPaise(row.balance) !== 0)
        .length,
    };
  }

  private async sum(where: Record<string, unknown>): Promise<string> {
    const result = await this.prisma.ledgerEntry.aggregate({
      where,
      _sum: { amount: true },
    });
    return fromPaise(toPaise((result._sum.amount ?? '0').toString()));
  }

  private total(rows: AccountBalance[]): string {
    return fromPaise(rows.reduce((sum, row) => sum + toPaise(row.balance), 0));
  }
}
