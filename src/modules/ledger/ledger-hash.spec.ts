import {
  GENESIS_HASH,
  computeEntryHash,
  verifyChain,
  type ChainLink,
  type HashableEntry,
} from './ledger-hash';

const BASE: HashableEntry = {
  sequence: 1,
  entryDate: new Date('2026-08-12T09:00:00.000Z'),
  txnType: 'charge',
  debitAccount: 'gateway:razorpay',
  creditAccount: 'revenue:bookings',
  amount: '1000.00',
  sourceRef: 'capture:order-1',
};

/** Build a valid chain of `n` links from genesis. */
function chain(n: number): ChainLink[] {
  const links: ChainLink[] = [];
  let prevHash = GENESIS_HASH;

  for (let i = 1; i <= n; i += 1) {
    const entry: HashableEntry = {
      ...BASE,
      sequence: i,
      sourceRef: `capture:order-${i}`,
      amount: `${100 * i}.00`,
    };
    const entryHash = computeEntryHash(prevHash, entry);
    links.push({ ...entry, prevHash, entryHash });
    prevHash = entryHash;
  }

  return links;
}

describe('computeEntryHash', () => {
  it('is a 64-character hex digest', () => {
    expect(computeEntryHash(GENESIS_HASH, BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(computeEntryHash(GENESIS_HASH, BASE)).toBe(
      computeEntryHash(GENESIS_HASH, BASE),
    );
  });

  it('changes when the predecessor changes — this is what makes it a chain', () => {
    expect(computeEntryHash(GENESIS_HASH, BASE)).not.toBe(
      computeEntryHash('a'.repeat(64), BASE),
    );
  });

  it.each([
    ['sequence', { sequence: 2 }],
    ['entryDate', { entryDate: new Date('2026-08-12T09:00:00.001Z') }],
    ['txnType', { txnType: 'refund' }],
    ['debitAccount', { debitAccount: 'bank:platform' }],
    ['creditAccount', { creditAccount: 'revenue:recoveries' }],
    ['amount', { amount: '1000.01' }],
    ['sourceRef', { sourceRef: 'capture:order-2' }],
  ])('changes when %s changes', (_field, override) => {
    expect(computeEntryHash(GENESIS_HASH, { ...BASE, ...override })).not.toBe(
      computeEntryHash(GENESIS_HASH, BASE),
    );
  });

  it('notices a millisecond, so a date is not silently truncated', () => {
    expect(
      computeEntryHash(GENESIS_HASH, {
        ...BASE,
        entryDate: new Date('2026-08-12T09:00:00.500Z'),
      }),
    ).not.toBe(computeEntryHash(GENESIS_HASH, BASE));
  });

  /**
   * The reason the separator is a control character. With a printable one, the
   * account pair (`a`, `b:c`) and (`a:b`, `c`) would produce the same payload —
   * so a forged entry moving money between two different accounts would verify
   * against the real one's hash.
   */
  it('cannot be fooled by moving a colon across the field boundary', () => {
    const left = computeEntryHash(GENESIS_HASH, {
      ...BASE,
      debitAccount: 'payable:pro',
      creditAccount: 'x:bank',
    });
    const right = computeEntryHash(GENESIS_HASH, {
      ...BASE,
      debitAccount: 'payable',
      creditAccount: 'pro:x:bank',
    });
    expect(left).not.toBe(right);
  });

  it('treats bigint and number sequences identically', () => {
    expect(computeEntryHash(GENESIS_HASH, { ...BASE, sequence: 7n })).toBe(
      computeEntryHash(GENESIS_HASH, { ...BASE, sequence: 7 }),
    );
  });
});

describe('verifyChain', () => {
  it('passes a chain it built itself', () => {
    expect(verifyChain(chain(5))).toEqual([]);
  });

  it('passes an empty ledger', () => {
    expect(verifyChain([])).toEqual([]);
  });

  it('catches an edited amount as a hash mismatch', () => {
    const links = chain(5);
    links[2] = { ...links[2], amount: '999999.00' };

    const breaks = verifyChain(links);
    const mismatch = breaks.find((b) => b.reason === 'hash_mismatch');
    expect(mismatch?.sequence).toBe('3');
  });

  it('catches a removed row as a gap and a broken link', () => {
    const links = chain(5);
    links.splice(2, 1); // drop sequence 3

    const breaks = verifyChain(links);
    expect(breaks.map((b) => b.reason)).toEqual(
      expect.arrayContaining(['sequence_gap', 'broken_link']),
    );
    expect(breaks[0].sequence).toBe('4');
  });

  it('catches a re-pointed prevHash as a broken link, not a hash mismatch', () => {
    const links = chain(4);
    // A row rewritten to chain from somewhere else, with its own hash
    // recomputed so it is internally consistent. Only the link is wrong.
    const forgedPrev = 'f'.repeat(64);
    const rebuilt = { ...links[2], prevHash: forgedPrev };
    links[2] = {
      ...rebuilt,
      entryHash: computeEntryHash(forgedPrev, rebuilt),
    };

    const breaks = verifyChain(links);
    expect(breaks.some((b) => b.reason === 'broken_link')).toBe(true);
    // Its own contents still produce its own hash — that is the distinction.
    expect(
      breaks.some((b) => b.reason === 'hash_mismatch' && b.sequence === '3'),
    ).toBe(false);
  });

  /**
   * One tamper, one break, at the row that was tampered with.
   *
   * The alternative — walking forward on the *recomputed* hash — would make a
   * single edited row invalidate every row after it, so a one-field change in
   * January reports as ten thousand breaks. The chain still catches the clever
   * version of the attack: an editor who also recomputes `entryHash` breaks the
   * *next* row's link instead, which the test above covers.
   */
  it('reports an edited row once, without cascading down the chain', () => {
    const links = chain(5);
    links[1] = { ...links[1], amount: '1.00' };

    const breaks = verifyChain(links);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ sequence: '2', reason: 'hash_mismatch' });
  });

  it('rejects a chain that does not start at genesis', () => {
    const links = chain(3);
    links[0] = { ...links[0], prevHash: 'b'.repeat(64) };

    expect(verifyChain(links)[0]).toMatchObject({
      sequence: '1',
      reason: 'broken_link',
      expected: GENESIS_HASH,
    });
  });

  it('verifies a page starting mid-chain when given the preceding hash', () => {
    const links = chain(6);
    const page = links.slice(3);

    expect(verifyChain(page, links[2].entryHash)).toEqual([]);
  });
});
