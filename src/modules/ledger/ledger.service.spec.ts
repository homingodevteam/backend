import { GENESIS_HASH, computeEntryHash } from './ledger-hash';
import { LedgerService } from './ledger.service';

function buildDeps() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    ledgerEntry: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ id: 'entry-1', ...data }),
        ),
    },
  };

  const prisma = {
    ledgerEntry: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  return { prisma, tx };
}

function build(deps: ReturnType<typeof buildDeps>): LedgerService {
  return new LedgerService(deps.prisma as never);
}

const ENTRY = {
  txnType: 'charge' as const,
  debitAccount: 'gateway:razorpay',
  creditAccount: 'revenue:bookings',
  amount: '1000.00',
  sourceRef: 'capture:order-1',
  entryDate: new Date('2026-08-12T09:00:00.000Z'),
};

describe('append', () => {
  it('starts the chain at genesis, sequence 1', async () => {
    const deps = buildDeps();

    await build(deps).append(ENTRY);

    const { data } = deps.tx.ledgerEntry.create.mock.calls[0][0];
    expect(data.sequence).toBe(1n);
    expect(data.prevHash).toBe(GENESIS_HASH);
    expect(data.entryHash).toBe(
      computeEntryHash(GENESIS_HASH, { ...ENTRY, sequence: 1n }),
    );
  });

  it('chains from the tail and increments the sequence', async () => {
    const deps = buildDeps();
    deps.tx.ledgerEntry.findFirst.mockResolvedValue({
      sequence: 41n,
      entryHash: 'c'.repeat(64),
    });

    await build(deps).append(ENTRY);

    const { data } = deps.tx.ledgerEntry.create.mock.calls[0][0];
    expect(data.sequence).toBe(42n);
    expect(data.prevHash).toBe('c'.repeat(64));
  });

  it('takes the chain lock before reading the tail', async () => {
    const deps = buildDeps();

    await build(deps).append(ENTRY);

    // Without this, two writers read the same tail and fork the chain into
    // branches that each verify locally and disagree with each other.
    expect(deps.tx.$executeRaw).toHaveBeenCalled();
    const lockCall = deps.tx.$executeRaw.mock.invocationCallOrder[0];
    const readCall = deps.tx.ledgerEntry.findFirst.mock.invocationCallOrder[0];
    expect(lockCall).toBeLessThan(readCall);
  });

  it('returns the existing entry for a repeated sourceRef', async () => {
    const deps = buildDeps();
    const existing = { id: 'entry-9', sourceRef: ENTRY.sourceRef };
    deps.prisma.ledgerEntry.findUnique.mockResolvedValue(existing);

    await expect(build(deps).append(ENTRY)).resolves.toBe(existing);
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns the winner when a repeat races past the first check', async () => {
    const deps = buildDeps();
    const winner = { id: 'entry-9', sourceRef: ENTRY.sourceRef };
    deps.tx.ledgerEntry.findUnique.mockResolvedValue(winner);

    await expect(build(deps).append(ENTRY)).resolves.toBe(winner);
    expect(deps.tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  /**
   * A zero entry records nothing and would still extend the chain. Thrown as a
   * plain Error rather than an apiError: reaching here means our own code tried
   * to book it, which is a bug, not something a client did.
   */
  it.each(['0.00', '0'])('refuses to book %s', async (amount) => {
    const deps = buildDeps();
    await expect(build(deps).append({ ...ENTRY, amount })).rejects.toThrow(
      /non-positive/,
    );
  });

  it('refuses an entry from an account to itself', async () => {
    const deps = buildDeps();
    await expect(
      build(deps).append({ ...ENTRY, creditAccount: ENTRY.debitAccount }),
    ).rejects.toThrow(/to itself/);
  });

  it('refuses a malformed amount rather than hashing it into the chain', async () => {
    const deps = buildDeps();
    await expect(
      build(deps).append({ ...ENTRY, amount: '1,000.00' }),
    ).rejects.toThrow();
  });

  it('carries the typed references through', async () => {
    const deps = buildDeps();

    await build(deps).append({
      ...ENTRY,
      bookingId: 'bk-1',
      orderId: 'ord-1',
      proId: 'pro-1',
      customerId: 'cust-1',
      razorpayPaymentId: 'pay_X',
    });

    expect(deps.tx.ledgerEntry.create.mock.calls[0][0].data).toMatchObject({
      bookingId: 'bk-1',
      orderId: 'ord-1',
      proId: 'pro-1',
      customerId: 'cust-1',
      razorpayPaymentId: 'pay_X',
      payoutId: null,
    });
  });
});

describe('verify', () => {
  /** Rows as Prisma returns them: Decimal-ish amounts, bigint sequences. */
  function row(sequence: bigint, prevHash: string, amount = '100.00') {
    const hashable = {
      sequence,
      entryDate: new Date('2026-08-12T09:00:00.000Z'),
      txnType: 'charge',
      debitAccount: 'gateway:razorpay',
      creditAccount: 'revenue:bookings',
      amount,
      sourceRef: `capture:order-${sequence}`,
    };
    return {
      ...hashable,
      amount: { toString: () => amount },
      prevHash,
      entryHash: computeEntryHash(prevHash, hashable),
    };
  }

  it('reports an empty ledger as intact', async () => {
    const deps = buildDeps();

    await expect(build(deps).verify()).resolves.toMatchObject({
      intact: true,
      entriesChecked: 0,
      firstSequence: null,
    });
  });

  it('walks a good chain and reports it intact', async () => {
    const deps = buildDeps();
    const first = row(1n, GENESIS_HASH);
    const second = row(2n, first.entryHash);
    deps.prisma.ledgerEntry.findMany
      .mockResolvedValueOnce([first, second])
      .mockResolvedValue([]);

    await expect(build(deps).verify()).resolves.toMatchObject({
      intact: true,
      entriesChecked: 2,
      firstSequence: '1',
      lastSequence: '2',
    });
  });

  it('catches a row whose amount was changed under it', async () => {
    const deps = buildDeps();
    const first = row(1n, GENESIS_HASH);
    const tampered = { ...first, amount: { toString: () => '999.00' } };
    deps.prisma.ledgerEntry.findMany
      .mockResolvedValueOnce([tampered])
      .mockResolvedValue([]);

    const result = await build(deps).verify();
    expect(result.intact).toBe(false);
    expect(result.breaks[0]).toMatchObject({
      sequence: '1',
      reason: 'hash_mismatch',
    });
  });

  /**
   * Verifying a page mid-chain needs the hash of the row before it, or every
   * page after the first reports a phantom broken link.
   */
  it('fetches the preceding hash when starting mid-chain', async () => {
    const deps = buildDeps();
    const first = row(1n, GENESIS_HASH);
    const second = row(2n, first.entryHash);
    deps.prisma.ledgerEntry.findFirst.mockResolvedValue({
      entryHash: first.entryHash,
    });
    deps.prisma.ledgerEntry.findMany
      .mockResolvedValueOnce([second])
      .mockResolvedValue([]);

    await expect(build(deps).verify({ from: 2n })).resolves.toMatchObject({
      intact: true,
    });
  });
});

describe('list', () => {
  it('serialises the sequence as a string, because BigInt is not JSON', async () => {
    const deps = buildDeps();
    deps.prisma.ledgerEntry.count.mockResolvedValue(1);
    deps.prisma.ledgerEntry.findMany.mockResolvedValue([
      { sequence: 42n, amount: { toString: () => '300.00' } },
    ]);

    const result = await build(deps).list({});
    expect(result.items[0].sequence).toBe('42');
    expect(result.items[0].amount).toBe('300.00');
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('matches an account on either leg', async () => {
    const deps = buildDeps();

    await build(deps).list({ account: 'payable:pro:1' });

    expect(deps.prisma.ledgerEntry.count.mock.calls[0][0].where.OR).toEqual([
      { debitAccount: 'payable:pro:1' },
      { creditAccount: 'payable:pro:1' },
    ]);
  });
});
