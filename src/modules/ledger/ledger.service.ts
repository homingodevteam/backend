import { Injectable, Logger } from '@nestjs/common';
import type { LedgerEntry, Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toPaise } from '../payments/payments.money';
import {
  GENESIS_HASH,
  computeEntryHash,
  verifyChain,
  type ChainBreak,
} from './ledger-hash';
import type { TxnType } from './ledger.types';

export interface AppendInput {
  txnType: TxnType;
  debitAccount: string;
  creditAccount: string;
  /** Rupee decimal string. */
  amount: string;
  /** Exactly-once key. Build it with `sourceRef.*`, never by hand. */
  sourceRef: string;
  entryDate?: Date;

  bookingId?: string | null;
  orderId?: string | null;
  payoutId?: string | null;
  proId?: string | null;
  customerId?: string | null;
  razorpayPaymentId?: string | null;
}

/**
 * Writing to the books.
 *
 * One public write method, and it is the only place in the codebase that
 * inserts into `ledger_entries`. Everything else goes through the adapter.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  /**
   * The key every ledger write serialises on.
   *
   * A constant, because the chain is global: two writers holding different
   * locks would both read the same tail and fork it into two branches that each
   * verify locally and disagree with each other — the exact failure a chain
   * exists to prevent, produced by the chain itself.
   *
   * **The cost, stated rather than discovered:** ledger writes are serial
   * platform-wide. Each holds the lock for one indexed single-row read and one
   * insert, so at this product's volume it is nothing. It will not hold at a
   * hundred times the volume, and the fix then is per-account chains — a
   * migration, not a rewrite.
   */
  private static readonly CHAIN_LOCK = 'ledger:chain';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append one balanced entry.
   *
   * Returns the existing row when `sourceRef` has already been written, rather
   * than throwing. Every caller is a retryable path — a redelivered webhook, a
   * re-run sweeper, a double-clicked button — and for all of them "it is
   * already recorded" is success, not an error.
   *
   * `amount` is validated through `toPaise`, which rejects anything that is not
   * a plain non-negative rupee amount. That is deliberate at this boundary: a
   * malformed amount reaching the books would be hashed into a chain nobody can
   * edit.
   */
  async append(input: AppendInput): Promise<LedgerEntry> {
    const existing = await this.prisma.ledgerEntry.findUnique({
      where: { sourceRef: input.sourceRef },
    });
    if (existing) return existing;

    if (toPaise(input.amount) <= 0) {
      // Not an apiError: reaching here means our own code tried to book a zero,
      // which is a bug rather than something a client did.
      throw new Error(
        `Refusing to append a non-positive ledger entry: ${input.sourceRef} for ${input.amount}`,
      );
    }
    if (input.debitAccount === input.creditAccount) {
      throw new Error(
        `Refusing to append an entry from ${input.debitAccount} to itself (${input.sourceRef})`,
      );
    }

    const entryDate = input.entryDate ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LedgerService.CHAIN_LOCK}, 0))`;

      // Re-read inside the lock. The check above is an optimisation that keeps
      // the common repeat off the lock entirely; this is the one that counts.
      const raced = await tx.ledgerEntry.findUnique({
        where: { sourceRef: input.sourceRef },
      });
      if (raced) return raced;

      const tail = await tx.ledgerEntry.findFirst({
        orderBy: { sequence: 'desc' },
        select: { sequence: true, entryHash: true },
      });

      // Gap-free, from the tail rather than a Postgres sequence: `nextval` is
      // non-transactional, so a rolled-back insert leaves a hole, and a hole in
      // a hash chain cannot be told apart from a deletion.
      const sequence = (tail?.sequence ?? 0n) + 1n;
      const prevHash = tail?.entryHash ?? GENESIS_HASH;

      const hashable = {
        sequence,
        entryDate,
        txnType: input.txnType,
        debitAccount: input.debitAccount,
        creditAccount: input.creditAccount,
        amount: input.amount,
        sourceRef: input.sourceRef,
      };

      return tx.ledgerEntry.create({
        data: {
          ...hashable,
          bookingId: input.bookingId ?? null,
          orderId: input.orderId ?? null,
          payoutId: input.payoutId ?? null,
          proId: input.proId ?? null,
          customerId: input.customerId ?? null,
          razorpayPaymentId: input.razorpayPaymentId ?? null,
          prevHash,
          entryHash: computeEntryHash(prevHash, hashable),
        },
      });
    });
  }

  /**
   * Recompute every hash in sequence and report what disagrees.
   *
   * A ledger nobody can check is a ledger nobody should trust, so this is the
   * first thing worth having. Streamed in pages rather than loaded whole — the
   * table only grows, and an integrity check that runs out of memory at the
   * point it matters is not a check.
   */
  async verify(options: { from?: bigint; limit?: number } = {}): Promise<{
    entriesChecked: number;
    firstSequence: string | null;
    lastSequence: string | null;
    breaks: ChainBreak[];
    intact: boolean;
  }> {
    const pageSize = 1_000;
    const stopAfter = options.limit ?? Number.POSITIVE_INFINITY;

    let cursor = options.from ?? 1n;
    let checked = 0;
    let firstSequence: string | null = null;
    let lastSequence: string | null = null;
    const breaks: ChainBreak[] = [];

    // Verifying a page needs the hash of the entry before it, or the first row
    // of every page after the first reports a phantom broken link.
    let prevHash = GENESIS_HASH;
    if (cursor > 1n) {
      const before = await this.prisma.ledgerEntry.findFirst({
        where: { sequence: { lt: cursor } },
        orderBy: { sequence: 'desc' },
        select: { entryHash: true },
      });
      prevHash = before?.entryHash ?? GENESIS_HASH;
    }

    for (;;) {
      const page = await this.prisma.ledgerEntry.findMany({
        where: { sequence: { gte: cursor } },
        orderBy: { sequence: 'asc' },
        take: Math.min(pageSize, stopAfter - checked),
      });
      if (page.length === 0) break;

      breaks.push(
        ...verifyChain(
          page.map((row) => ({
            sequence: row.sequence,
            entryDate: row.entryDate,
            txnType: row.txnType,
            debitAccount: row.debitAccount,
            creditAccount: row.creditAccount,
            amount: row.amount.toString(),
            sourceRef: row.sourceRef,
            prevHash: row.prevHash,
            entryHash: row.entryHash,
          })),
          prevHash,
        ),
      );

      firstSequence ??= page[0].sequence.toString();
      lastSequence = page[page.length - 1].sequence.toString();
      prevHash = page[page.length - 1].entryHash;
      cursor = page[page.length - 1].sequence + 1n;
      checked += page.length;

      if (page.length < pageSize || checked >= stopAfter) break;
    }

    if (breaks.length > 0) {
      this.logger.error(
        `LEDGER INTEGRITY FAILURE: ${breaks.length} break(s), first at sequence ${breaks[0].sequence} (${breaks[0].reason}).`,
      );
    }

    return {
      entriesChecked: checked,
      firstSequence,
      lastSequence,
      breaks,
      intact: breaks.length === 0,
    };
  }

  /** Paged read for the admin console. */
  async list(query: {
    page?: number;
    limit?: number;
    txnType?: string;
    account?: string;
    proId?: string;
    bookingId?: string;
    payoutId?: string;
    from?: string;
    to?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const where: Prisma.LedgerEntryWhereInput = {
      ...(query.txnType ? { txnType: query.txnType } : {}),
      ...(query.proId ? { proId: query.proId } : {}),
      ...(query.bookingId ? { bookingId: query.bookingId } : {}),
      ...(query.payoutId ? { payoutId: query.payoutId } : {}),
      ...(query.account
        ? {
            OR: [
              { debitAccount: query.account },
              { creditAccount: query.account },
            ],
          }
        : {}),
      ...(query.from || query.to
        ? {
            entryDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.ledgerEntry.count({ where }),
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: { sequence: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      page,
      limit,
      total,
      items: rows.map((row) => ({
        ...row,
        // BigInt does not survive JSON.stringify, and the alternative — a
        // global BigInt serialiser — would change how every other module's
        // responses look.
        sequence: row.sequence.toString(),
        amount: row.amount.toString(),
      })),
    };
  }
}
