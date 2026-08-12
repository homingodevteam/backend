import { createHash } from 'node:crypto';

/**
 * The chain. One function, pure, with a canonical field order that must never
 * change.
 *
 * Every hash in the table was computed by this exact code. Reorder a field,
 * change a separator, alter how a date is formatted — and every entry written
 * before the change stops verifying, all at once, with no way to tell that
 * apart from tampering. That is why this is its own file with its own spec,
 * why the field order is written out longhand rather than derived from
 * `Object.keys`, and why the separator is a character that cannot occur in any
 * of the values.
 */

/**
 * What the first entry chains from.
 *
 * A constant rather than an empty string, so "no previous hash" and "the
 * previous hash was blank" are different values.
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * ``, ASCII unit separator. Chosen because it cannot appear in a UUID, a
 * decimal string, an ISO timestamp or any account name this module builds — so
 * no value can impersonate a field boundary.
 *
 * With a printable separator, an account named `a:b` and a pair of accounts
 * `a` and `b` would hash identically, and a forged entry would verify.
 */
const SEP = '';

export interface HashableEntry {
  sequence: bigint | number;
  entryDate: Date;
  txnType: string;
  debitAccount: string;
  creditAccount: string;
  /** Rupee decimal string, already normalised to two places. */
  amount: string;
  sourceRef: string;
}

/**
 * Compute an entry's hash from its predecessor's.
 *
 * `entryDate` goes in as an ISO string with milliseconds — the same form it
 * round-trips through Postgres as, so a hash recomputed after a read matches
 * the one computed before the write. Using `getTime()` would be shorter and
 * would silently disagree the moment a column's precision changed.
 */
export function computeEntryHash(
  prevHash: string,
  entry: HashableEntry,
): string {
  const payload = [
    prevHash,
    entry.sequence.toString(),
    entry.entryDate.toISOString(),
    entry.txnType,
    entry.debitAccount,
    entry.creditAccount,
    entry.amount,
    entry.sourceRef,
  ].join(SEP);

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export interface ChainLink extends HashableEntry {
  prevHash: string;
  entryHash: string;
}

export interface ChainBreak {
  sequence: string;
  reason: 'hash_mismatch' | 'broken_link' | 'sequence_gap';
  expected: string;
  found: string;
}

/**
 * Walk a run of entries and report the first thing wrong with it.
 *
 * Three distinct failures, kept distinct because they mean different things to
 * whoever is reading the alert:
 *
 * - `hash_mismatch` — the row's own contents no longer produce its hash. A
 *   field was changed.
 * - `broken_link` — the row's `prevHash` is not its predecessor's hash. A row
 *   was inserted, removed, or reordered.
 * - `sequence_gap` — a number is missing. Since sequences are gap-free by
 *   construction, this means a row is gone.
 *
 * Returns every break rather than stopping at the first: one tampered row
 * breaks its own hash *and* the link of the row after it, and reporting only
 * the first would understate a wider problem.
 */
export function verifyChain(
  entries: readonly ChainLink[],
  startingPrevHash: string = GENESIS_HASH,
): ChainBreak[] {
  const breaks: ChainBreak[] = [];
  let expectedPrev = startingPrevHash;
  let expectedSequence: bigint | null = null;

  for (const entry of entries) {
    const sequence = BigInt(entry.sequence);

    if (expectedSequence !== null && sequence !== expectedSequence) {
      breaks.push({
        sequence: sequence.toString(),
        reason: 'sequence_gap',
        expected: expectedSequence.toString(),
        found: sequence.toString(),
      });
    }

    if (entry.prevHash !== expectedPrev) {
      breaks.push({
        sequence: sequence.toString(),
        reason: 'broken_link',
        expected: expectedPrev,
        found: entry.prevHash,
      });
    }

    // Recomputed from the row's own `prevHash`, not from `expectedPrev`. A
    // broken link is already reported above; asking the second question against
    // what the row actually claims is what separates "this row was edited" from
    // "the row before it was".
    const recomputed = computeEntryHash(entry.prevHash, entry);
    if (recomputed !== entry.entryHash) {
      breaks.push({
        sequence: sequence.toString(),
        reason: 'hash_mismatch',
        expected: recomputed,
        found: entry.entryHash,
      });
    }

    expectedPrev = entry.entryHash;
    expectedSequence = sequence + 1n;
  }

  return breaks;
}
