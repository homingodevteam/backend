# Module 9 — Ledger & Reconciliation · Implementation Plan

**Date:** 2026-08-12 · **Built:** 2026-08-12
**Status:** ✅ **Built.** §10 records where the code departed from this plan.
**Estimated size:** ~1,500 lines, 7 endpoints, 2 tables — roughly a third of
module 8, because most of the work is already done elsewhere.

---

## 0 · The blocker, and its answer

**CONFLICTS_AND_DECISIONS #52 — resolved 2026-08-12.** `commissionValue` is the
rate the **Pro earns** and `commissionAmount` is the amount to be paid to the
Pro. Confirmed with the business, not inferred from the schema.

This mattered more here than anywhere else. Every other module tolerates being
wrong for a week; this one is append-only and hash-linked, so it would have
recorded the wrong number forever in the one structure built so nothing can edit
it. The code was already correct, so nothing changed — but the question is now
closed rather than open, and `SetCommissionDto` says the direction in words for
whoever types the number in.

---

## 1 · Where the code already stands

More than half of this module's feature list is built, in other modules.

| Feature                          | State                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Nightly counter rebuild          | ✅ **Done.** `ProCountersService.rebuildAll` — self-scheduling, Redis-locked, with drift logging |
| Reconciliation engine            | 🟡 306 lines in `payments/reconciliation.service.ts`, 6 discrepancy kinds. **Not persisted**     |
| Where ledger entries are written | ✅ 8 call sites, typed, already invoked — 4 in module 7, 4 in module 8, all bound to no-op ports |
| `LedgerEntry`                    | ❌ In the ERD, absent from Prisma                                                                |
| `ReconciliationRun`              | ❌ Same                                                                                          |

The 8 call sites are the important part: **this module writes no business
logic.** Every event that should produce an entry already calls a port with a
typed payload. The work is filling those in, not finding them.

```
payments/orders.service.ts:440          recordCapture
payments/cash-collection.service.ts:66  recordCashCollection
payments/cash-handover.service.ts:165   recordHandover
payments/refunds.service.ts:242         recordRefund
commission/commission.service.ts:165        recordAccrual
commission/incentive-evaluation.service.ts:325  recordIncentiveCredit
commission/commission-reversal.service.ts:182   recordReversal
commission/payout-disbursement.service.ts:282   recordDisbursement
```

---

## 2 · Scope

### In

1. `LedgerEntry` with the hash chain.
2. One adapter per port, registered into both delegates at boot.
3. `ReconciliationRun` + `ReconciliationDiscrepancy` — persisting the answers
   the existing service already computes, and extending it to commission and
   payouts.
4. The nightly job: reconcile, then call the existing counter rebuild.
5. Balance queries: collections today, owed out, outstanding dues.

### Out, deliberately

| Cut                        | Why                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Variance **trend**         | Needs history nobody has yet. Ship the runs; the trend is a query over them in three months       |
| Discrepancy **workflow**   | States, assignment, threads — that is a ticket system. One `resolve` endpoint with notes instead  |
| `platform_revenue` entries | Derivable: `revenue:bookings − expense:pro_commission`. A stored copy is a second thing to drift  |
| Auto-correction            | Never. A discrepancy is a question for a human; making our row match theirs destroys the evidence |

`platform_revenue` stays in the `txnType` vocabulary so the column matches the
ERD — nothing writes it in v1, and the dashboard computes it.

---

## 3 · Schema

Two tables, both close to the ERD.

```prisma
model LedgerEntry {
  id        String   @id @default(uuid()) @db.Uuid
  createdAt DateTime @default(now())

  /// Gap-free, from a Postgres sequence. The chain's spine: entry N verifies
  /// against N-1, and a missing number is itself the alarm.
  sequence  BigInt   @unique
  entryDate DateTime

  /// charge | refund | platform_revenue | pro_commission | deduction | incentive
  txnType       String
  debitAccount  String
  creditAccount String
  amount        Decimal @db.Decimal(12, 2)
  currency      String  @default("INR")

  bookingId         String? @db.Uuid
  orderId           String? @db.Uuid   // null for cash — there is no Order
  payoutId          String? @db.Uuid
  proId             String? @db.Uuid
  customerId        String? @db.Uuid
  razorpayPaymentId String?            // gateway reference, not a local FK

  /// Exactly-once key, same idea as PayoutDeduction.dedupeKey:
  /// `capture:<orderId>`, `accrual:<commissionId>`. A retried webhook or a
  /// re-run sweeper must not write a second entry for one event.
  sourceRef String @unique

  prevHash  String
  entryHash String @unique

  @@index([entryDate])
  @@index([debitAccount, entryDate])
  @@index([creditAccount, entryDate])
  @@map("ledger_entries")
}
```

`ReconciliationRun` per the ERD, plus `ReconciliationDiscrepancy` carrying the
existing `Discrepancy` interface's fields verbatim — `kind`, `reference`,
`ours`, `theirs`, `variance`, `detail` — with `resolvedAt`,
`resolvedByAdminId`, `resolutionNotes`.

**No `UPDATE` or `DELETE` anywhere in this module.** Enforce it in the database
too, not just by convention:

```sql
CREATE RULE ledger_entries_no_update AS ON UPDATE TO "ledger_entries" DO INSTEAD NOTHING;
CREATE RULE ledger_entries_no_delete AS ON DELETE TO "ledger_entries" DO INSTEAD NOTHING;
```

---

## 4 · The hash chain, and the one thing it costs

```
entryHash = sha256(prevHash + sequence + entryDate + txnType +
                   debitAccount + creditAccount + amount + sourceRef)
```

Canonical field order, fixed, in a single pure function with its own spec. The
first entry chains from a constant genesis hash.

**Writes must be serialised.** Two concurrent inserts both read the same
`prevHash` and the chain forks into two branches that each verify locally and
disagree globally — the failure a chain exists to prevent, produced by the chain
itself. So every write takes `pg_advisory_xact_lock` on one constant key, reads
the tail, and inserts.

**The cost, stated plainly:** all ledger writes are serial, platform-wide. At
10,000 customers this is a few writes a second against an indexed single-row
read, which is nothing. It will not hold at a hundred times that, and the fix
then is per-account chains rather than one global chain — a migration, not a
rewrite. Writing it down now so the ceiling is a known one.

**Non-fatal, like every other ledger call today.** By the time these run the
money has already moved. A missing entry is recoverable — the whole ledger is
rebuildable from `Order`, `Booking`, `CashHandover`, `BookingCommission` and
`CommissionPayout`, which is exactly what reconciliation checks. Refusing a cash
collection because a bookkeeping row failed would strand a Pro at a customer's
door.

---

## 5 · The accounts

Double-entry as **one row with two account columns**, per the ERD. Every row is
inherently balanced; an account's balance is `sum(credits) − sum(debits)`.

| Event               | txnType          | Debit                    | Credit                   |
| ------------------- | ---------------- | ------------------------ | ------------------------ |
| Online capture      | `charge`         | `gateway:razorpay`       | `revenue:bookings`       |
| Cash collected      | `charge`         | `cash_in_hand:<proId>`   | `revenue:bookings`       |
| Handover confirmed  | `charge`         | `bank:platform`          | `cash_in_hand:<proId>`   |
| Refund settled      | `refund`         | `revenue:bookings`       | `gateway:razorpay`       |
| Commission accrued  | `pro_commission` | `expense:pro_commission` | `payable:pro:<proId>`    |
| Incentive credited  | `incentive`      | `expense:incentives`     | `payable:pro:<proId>`    |
| Commission reversed | `pro_commission` | `payable:pro:<proId>`    | `expense:pro_commission` |
| Deduction consumed  | `deduction`      | `payable:pro:<proId>`    | `revenue:recoveries`     |
| Payout confirmed    | `pro_commission` | `payable:pro:<proId>`    | `bank:platform`          |

A reversal is a **new entry with the legs swapped**, never a negative amount and
never an edit. `cash_in_hand:<proId>` is named by the ERD and is the account
`Pro.cashInHand` is a cache of — which makes "does the cached balance match the
ledger" a real check rather than a tautology.

Three things fall out of this table for free, which is the point of doing it
this way:

- **Collections today** — credits to `revenue:bookings` since Indian midnight.
- **Owed out** — the balance of every `payable:pro:*`.
- **Cash on the street** — the balance of every `cash_in_hand:*`, cross-checked
  against `Pro.cashInHand`.

---

## 6 · Reconciliation

Extend, do not rebuild. `ReconciliationService` already answers the money and
cash questions; it just throws the answer away.

**Wrap it:** open a `ReconciliationRun`, call the existing method, persist the
discrepancies it returns, close the run. That alone delivers "nightly
reconciliation" and "discrepancy detection" for the money and cash scopes.

**Then add three ledger-scope checks:**

| Check                    | Finds                                                     |
| ------------------------ | --------------------------------------------------------- |
| `missing_ledger_entry`   | A captured order, commission or paid payout with no entry |
| `ledger_amount_mismatch` | An entry whose amount disagrees with its source row       |
| `orphan_ledger_entry`    | An entry whose `bookingId` / `payoutId` points at nothing |

Plus `chain_broken` from the verifier — recomputing every hash in sequence and
reporting the first that disagrees.

**The nightly job** reuses module 8's worker pattern (self-rescheduling
`setTimeout`, `unref`'d, Redis-locked — no new dependency): reconcile, then call
`ProCountersService.rebuildAll()`. That is feature 7 satisfied by one line,
because the rebuild already exists and already self-heals drift within 24 hours.

---

## 7 · API — 7 endpoints

| Method | Route                                             | Permission     |
| ------ | ------------------------------------------------- | -------------- |
| `GET`  | `/admin/ledger`                                   | `ledger.read`  |
| `GET`  | `/admin/ledger/verify`                            | `ledger.read`  |
| `GET`  | `/admin/ledger/balances`                          | `ledger.read`  |
| `GET`  | `/admin/finance/dashboard`                        | `ledger.read`  |
| `POST` | `/admin/reconciliation/run`                       | `ledger.audit` |
| `GET`  | `/admin/reconciliation/runs`                      | `ledger.read`  |
| `POST` | `/admin/reconciliation/discrepancies/:id/resolve` | `ledger.audit` |

Two new permission codes. `ledger.read` is safe and can go to finance and ops;
`ledger.audit` runs the job and closes discrepancies.

`GET /admin/ledger/verify` is the one worth building first — a ledger nobody can
check is a ledger nobody should trust.

`/admin/finance/dashboard` is three balance queries in a response object:
in today, owed out, cash on the street. Not a reporting engine.

---

## 8 · Build order

| Phase | Work                                                                   |
| ----- | ---------------------------------------------------------------------- |
| A     | Schema + migration, including the no-UPDATE/no-DELETE rules            |
| B     | `ledger-hash.ts` — pure, with a spec pinning the canonical field order |
| C     | `LedgerService.append` — sequence, advisory lock, `sourceRef` dedupe   |
| D     | The 8 adapter methods; register into both delegates                    |
| E     | `verify`, `balances`, the dashboard                                    |
| F     | Persist the existing reconciliation; add the 3 ledger checks           |
| G     | Nightly job → reconcile + `rebuildAll`                                 |
| H     | Specs, docs                                                            |

Phases C and D are the substance. E onward is mostly queries.

Only one file outside this module changes: `permission-code.ts`. Both ports
already exist and both delegates already accept a registration, so modules 7 and
8 are untouched.

---

## 9 · Done means

- [ ] The chain verifies end to end, and a tampered row is reported with its sequence
- [ ] `UPDATE` and `DELETE` on `ledger_entries` are refused by the database
- [ ] A retried webhook or a re-run sweeper writes no second entry (`sourceRef`)
- [ ] Every one of the 8 call sites writes exactly one balanced entry
- [ ] A reversal appends swapped legs — no negative amounts, no edits
- [ ] `sum(cash_in_hand:*)` matches `sum(Pro.cashInHand)`, and a mismatch is a discrepancy
- [ ] A missing entry for a captured order is found by reconciliation
- [ ] Nothing is auto-corrected
- [ ] The nightly job calls the existing counter rebuild rather than a second one
- [ ] A ledger write that fails does not fail the payment, payout or collection above it

---

## 10 · What the build changed

Three departures, all of them found while writing the code rather than while
reviewing the plan.

### 10.1 · A reversal after payment books nothing — §5's table was wrong

The account table gave reversal one row. It needs two cases, and the second one
is "no entry at all": after payment `payable:pro` is already zero and the money
is in the Pro's bank, so debiting it again would drive the account negative and
state that money came back when it has not — permanently, in a table that
cannot be edited.

What the platform holds then is a **claim**, which already lives in
`PayoutDeduction` and becomes an entry only when a later payout consumes it.
Same reasoning one step later: deductions are booked at **settlement**, not when
a batch claims them, because rejecting a batch gives its claims back. Recorded
as **#55**.

This is what makes the strongest reconciliation check possible — `payable:pro`
returning to exactly zero for a settled Pro.

### 10.2 · A trigger that raises, not a rule that does nothing

§3 proposed `CREATE RULE ... DO INSTEAD NOTHING`. That makes an `UPDATE`
silently succeed while changing nothing — the exact shape of bug the table
exists to prevent. A `BEFORE UPDATE/DELETE` trigger that raises turns the same
mistake into a stack trace with a table name in it.

Verified against a real Postgres rather than asserted: insert a row, attempt an
`UPDATE`, attempt a `DELETE`, roll back. Both refused.

_(The first version of that check reported a false negative — a failed statement
aborts the surrounding Postgres transaction, so the second attempt errored for
the wrong reason and looked like a pass. Each attempt now runs in its own
transaction.)_

### 10.3 · Gap-free sequences come from `MAX + 1`, not a sequence object

§3 said "from a Postgres sequence" and "gap-free" in the same sentence, and the
two are incompatible: `nextval` is non-transactional, so a rolled-back insert
leaves a hole — and a hole in a hash chain cannot be told apart from a deletion.

Every write already serialises on the chain lock, so reading the tail and adding
one is both correct and free.

### One bug the specs caught

`rupeesDifference` returns a signed figure and `toPaise` rejects a negative, so
summing variance would have thrown the first time the ledger recorded _less_
than its source — taking down the nightly run in precisely the case worth
catching. Module 7 already handled this with `.replace('-', '')`; this module
now does the same, and sums magnitudes so two errors in opposite directions
report as two problems rather than as none.

---

## 11 · Definition of done — verified

Every box in §9. Evidence: **762 unit tests** (83 new in `src/modules/ledger/`),
**175 e2e**, typecheck and lint clean, migration applied and diffed with no
drift, and the append-only guarantee proven against a live database.

The three worth reading the tests for:

- `ledger-hash.spec.ts` — "cannot be fooled by moving a colon across the field
  boundary". The separator is `` for a reason: with a printable one, two
  different account pairs hash identically and a forged entry verifies.
- `ledger-hash.spec.ts` — "reports an edited row once, without cascading". One
  tamper reports one break, at the row that was tampered with, instead of
  invalidating every row after it.
- `ledger-adapter.service.spec.ts` — "payable:pro nets to zero over a full
  cycle". Walks earnings, a bonus, a deduction and a payout, and asserts the
  account returns to zero. That is the invariant the nightly run checks against
  the live table.
