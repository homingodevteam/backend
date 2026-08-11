# Module 8 — Commission & Payouts · Implementation Plan

**Date:** 2026-08-11
**Status:** plan only — no module 8 code written yet.

Written against [`Modules_and_Features 1.md`](Modules_and_Features%201.md) §8, the
US-8.x stories in [`user-stories-by-persona/`](user-stories-by-persona/),
[`ERD_DATA_MODEL_V10.md`](ERD_DATA_MODEL_V10.md), and
[`CONFLICTS_AND_DECISIONS.md`](CONFLICTS_AND_DECISIONS.md) #7, #17, #18 and #33.

> **This is the second module that moves real money, and the larger of the two.**
> Module 7 takes money from customers in amounts they agreed to. This one sends
> money out, in amounts nobody outside the system can check, to people who
> depend on it. Every design choice below leans toward _visible and recoverable_
> over _automatic_.

---

## 1 · The salary question, settled first

The brief for this pass added something the source documents do not have: the
Pro is a **company employee on a monthly salary**, with a variable component on
top.

That collides with three things already written down:

| Where               | What it says                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `Pro.monthlySalary` | "Bookkeeping only — **this system never pays salary**, only commission" |
| `Pro.employeeCode`  | "Payroll identity — **payroll itself is external** to this system"      |
| §8, first line      | "**The only** Pro compensation this system calculates"                  |
| `CommissionPayout`  | commission + incentive − deduction. **No salary line**                  |

**Decision: salary stays external.** Payroll pays it; this system records
`monthlySalary` for reporting and disburses only the variable part — commission
and incentives. All four statements above stay true, and `CommissionPayout`
needs no new column.

**Why, beyond "it is what the schema says".** Disbursing salary would make this
a payroll system, and payroll in India carries TDS, PF, ESI, payslips and
statutory registers — none of which is modelled here and none of which is a
week's work. Pushing salary out is not a simplification; it is the boundary
that keeps this module about _what a job earned_ rather than _what an employee
is owed_. See CONFLICTS_AND_DECISIONS #45.

**Consequence to accept:** a Pro's total pay is assembled from two systems and
lives in neither. Nothing here can answer "what did this person earn in March"
end to end, and the Pro app's earnings view shows the variable half only. That
must be labelled in the UI, or it reads as a wrong number rather than a partial
one.

---

## 2 · Where the code stands today

| Thing                                        | State                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/commission/`                    | **Does not exist.**                                                                                                                                  |
| `BookingCommission`                          | Stub — but a **complete** one; all 13 ERD columns are present                                                                                        |
| `CommissionPayout`                           | Stub — all 14 ERD columns present, including `bankAccountId` and `payoutReference`                                                                   |
| `Incentive`, `ProIncentiveProgress`          | **Do not exist.** In the ERD, absent from Prisma                                                                                                     |
| `Service.commissionType` / `commissionValue` | ✅ Live, nullable, and **activation is already gated on both being set** (US-3.11) — feature 1 and US-8.8 are done in module 3                       |
| `catalog.commission.set`                     | ✅ A finance-only permission, deliberately split from `catalog.manage` (#17)                                                                         |
| `ProBankAccount`                             | ✅ Built, with masked-format enforcement                                                                                                             |
| Booking completion hook                      | ✅ `booking-lifecycle.service.ts` already calls `ProCountersService.recordCompletion` in a non-fatal try/catch — the shape this module's hook copies |
| `Booking.actualDurationMinutes`              | ✅ Computed at completion, **reporting only** (#18)                                                                                                  |
| `LedgerEntry`                                | ❌ Module 9. Module 7 already owns a `LedgerPort` stub                                                                                               |
| RazorpayX                                    | ❌ Not a dependency, and **not the same API as module 7's Razorpay**                                                                                 |

The stub tables are the good news: unlike module 7's `Order`, which did not
exist at all, both of this module's core tables are already the full ERD shape.
The genuinely new schema is the two incentive tables.

---

## 3 · Contradictions and decisions

### 3.1 Two `LEDGER_PORT` symbols would collide

Module 7 owns `payments/ports/ledger.port.ts`, exporting a symbol literally
named `LEDGER_PORT`. This module needs the ledger too — commission accrual,
payout disbursement, reversal.

Defining a second `LEDGER_PORT` gives two distinct symbols with the same name,
which is legal, works, and is a trap: the next person to see
`@Inject(LEDGER_PORT)` has no way to know which one they are looking at.

**Recommendation:** this module defines `COMMISSION_LEDGER_PORT`, with its own
methods, in its own folder. Not shared with module 7's — the entries are
different (a charge versus an accrual), and sharing would make module 8 depend
on module 7 for no reason beyond a name. When module 9 lands it registers into
both delegates, which is the pattern already used three times.

### 3.2 Commission must be computed at completion, and module 4 owns completion

Feature 3 says "the moment the job completes", and US-8.5 says the Pro's live
earnings update immediately. The transition lives in
`booking-lifecycle.service.ts`.

**Recommendation:** a fourth port on module 4 — `COMMISSION_PORT`, delegate-
registered like dispatch (#32), payments and serviceability. Its call sits
beside the existing `recordCompletion` call and copies its **non-fatal**
shape.

Non-fatal is the right call for the _counter_, and the reasoning transfers only
partly here. A missing counter is derived data the nightly rebuild fixes; a
missing commission row is **money a Pro has not been credited**. So: non-fatal
at the call site — a Pro must never see their completed job fail because a
commission row did not write — but backed by a **sweeper** that finds completed
bookings with no commission row and computes them. Logging alone would mean the
Pro silently loses the job's pay.

### 3.3 US-8.5's edge contradicts #18 at first reading

> "Duration comes from the OTP-verified start. **No verified start, no
> defensible duration, no commission.**"

Conflict #18 cancelled duration as a commission input entirely — one flat rate
per service, a four-hour job pays what a one-hour one does. So why would a
missing start block commission?

**They are not actually in conflict.** #18 is about the _rate_; US-8.5's edge is
about _evidence the job happened at all_. `Booking.startOtpProviderRef` is the
trust anchor (#25) — without a verified start or an audited ops force-start,
there is no proof the Pro was ever at the customer's door.

**Recommendation:** commission requires `startedAt` to be set, which module 4
already guarantees only a verified OTP or an audited force-start can do. Record
`actualDurationMinutes` on the row as the ERD asks, purely for reporting, and
**never read it in the calculation**. A spec should assert that changing the
duration changes nothing about the amount.

### 3.4 Reversal is a deduction, never a clawback — and the sequencing is subtle

US-8.13/8.14 are emphatic: **money is never debited from a Pro's bank account.**
A reversed commission that was already paid becomes an itemised deduction on the
next payout.

That is easy to state and easy to get wrong, because it depends on _when_ the
reversal arrives relative to the payout:

| Commission status when reversed       | Correct behaviour                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `pending` / `approved`, not yet swept | Mark `reversed`. It never reaches a payout                                           |
| `paid`                                | Leave the row paid — it _was_ paid. Raise a **deduction** carried to the next payout |
| Already deducted once                 | Must not deduct twice. The deduction needs its own identity                          |

**Recommendation:** a deduction is a **row**, not a running total on the Pro.
`CommissionPayout.deductionAmount` is a sum of deduction rows, and each row
records what it was for and which payout consumed it. A `Pro.pendingDeduction`
scalar would be unauditable and would double-apply on a retry.

### 3.5 A reversal must decrement incentive progress

US-8.7's edge: "A later reversal of that job must decrement the progress, or a
cancelled job banks a permanent bonus."

**Recommendation:** `ProIncentiveProgress` records `commissionId` — the ERD
already has the column — so a reversal can find the progress it contributed to
and unwind it. If the incentive was already _credited_, it becomes a deduction
by the same mechanism as 3.4 rather than a negative progress value.

### 3.6 Only two of the four incentive types have definitions

The ERD names `jobs_count | streak | rating | surge_slot`. US-8.7 marks the
criteria **explicitly undefined** in the source documents.

**Decision: build evaluators for `jobs_count` and `rating` only.** Both compute
from data that already exists and is already correct — `Pro.completedJobs`,
`ratingSum` / `ratingCount`, with the smoothed-rating prior module 5 already
uses. `streak` and `surge_slot` need business definitions nobody has written:
what breaks a streak, what makes a slot surge, who decides.

The `incentiveType` column accepts all four, so configuring one is possible;
what does not exist is automatic crediting for the two undefined ones. That is
a **visible** gap — an admin creating a `streak` incentive should get a clear
"no evaluator for this type yet" rather than silence.

### 3.7 RazorpayX is a different product from module 7's Razorpay

Different base URL, different credentials, different dashboard. Module 7's
`RazorpayClient` cannot be reused.

**Recommendation:** a separate `RazorpayXClient` in this module, over `fetch`,
with the same shape as module 7's — including `buildRazorpayXOptions` returning
`undefined` when unconfigured, so the app boots and everything except
disbursement works without payout credentials. Approval still works; only the
transfer is unavailable, which is the honest state.

### 3.8 Approval and execution must be separate permissions

US-8.10 is explicit, and calls this "the largest outbound money movement in the
system".

**Recommendation:** `payout.approve` and `payout.disburse` as distinct codes,
neither granted to `ops` by default. Finance approves; disbursement is its own
grant. The module 1 permission file is a coordination event, as in module 7.

---

## 4 · Schema

Both core tables already match the ERD, so this is mostly **two new tables**.

```prisma
model Incentive {
  id, createdAt, updatedAt
  name          String
  /// jobs_count | streak | rating | surge_slot.
  /// Only the first and third have evaluators — see 3.6.
  incentiveType String
  criteriaJson  Json
  rewardAmount  Decimal @db.Decimal(12, 2)
  cityId        String? @db.Uuid   // null = platform-wide
  validFrom     DateTime
  validTo       DateTime?
  isActive      Boolean @default(true)
}

model ProIncentiveProgress {
  id, createdAt, updatedAt
  proId          String @db.Uuid
  incentiveId    String @db.Uuid
  progressValue  Decimal @db.Decimal(12, 2)
  targetValue    Decimal @db.Decimal(12, 2)
  achievedAt     DateTime?
  rewardCredited Boolean @default(false)
  /// The job the reward was credited against — and what a reversal
  /// follows back to unwind it (3.5).
  commissionId   String? @db.Uuid

  @@unique([proId, incentiveId])
}
```

Plus one table the ERD does not have, for 3.4:

```prisma
/// A reversal that arrived after the money was already paid.
/// A ROW, not a running total — see 3.4 for why a scalar on Pro
/// would double-apply on a retry and be unauditable.
model PayoutDeduction {
  id, createdAt, updatedAt
  proId          String @db.Uuid
  amount         Decimal @db.Decimal(12, 2)
  reason         String
  sourceCommissionId String? @db.Uuid
  /// Null until a payout consumes it. Set once.
  consumedByPayoutId String? @db.Uuid
}
```

### Settings

| Key                               | Default | Why                                                        |
| --------------------------------- | ------- | ---------------------------------------------------------- |
| `payout.periodDays`               | `30`    | Batch period. Not hard-coded — #26's rule                  |
| `payout.minimumNetAmount`         | `0`     | Below this, roll into the next period rather than transfer |
| `commission.sweeperLookbackHours` | `48`    | How far back 3.2's safety net looks                        |

---

## 5 · API surface (draft)

| Method               | Route                            | Actor | Feature                            |
| -------------------- | -------------------------------- | ----- | ---------------------------------- |
| `GET`                | `/pros/me/earnings`              | pro   | 9 — live, updates as jobs complete |
| `GET`                | `/pros/me/earnings/commissions`  | pro   | 5                                  |
| `GET`                | `/pros/me/incentives`            | pro   | 8 — progress, not just achieved    |
| `GET`                | `/pros/me/payouts`               | pro   | 12 — **readable while suspended**  |
| `GET`                | `/pros/me/payouts/:id`           | pro   | 12                                 |
| `POST`               | `/admin/payouts/generate`        | admin | 10                                 |
| `POST`               | `/admin/payouts/:id/approve`     | admin | 11 · `payout.approve`              |
| `POST`               | `/admin/payouts/:id/disburse`    | admin | 12 · `payout.disburse`             |
| `GET`                | `/admin/payouts`                 | admin |                                    |
| `POST`               | `/admin/commissions/:id/reverse` | admin | 13                                 |
| `GET`/`POST`/`PATCH` | `/admin/incentives`              | admin | 7                                  |

`/pros/me/payouts` carries `@AllowSuspendedProRead()` — US-8.12 is explicit that
money already earned is still owed, and a suspended Pro must be able to see it.

---

## 6 · Deferred

| Item                               | Blocked on                   | Seam                                    |
| ---------------------------------- | ---------------------------- | --------------------------------------- |
| Ledger entries                     | Module 9                     | `COMMISSION_LEDGER_PORT`, no-op logs    |
| `streak` / `surge_slot` evaluators | **Undefined business rules** | Table accepts the type; no evaluator    |
| Payout failure notification        | Module 12                    | `status = failed` is set; nothing sends |
| Salary                             | **Out of scope by decision** | External payroll — 1 and #45            |

---

## 7 · Build order

| Phase | Work                                                                     |
| ----- | ------------------------------------------------------------------------ |
| A     | Schema: `Incentive`, `ProIncentiveProgress`, `PayoutDeduction`; settings |
| B     | Commission calculation + snapshotting; `COMMISSION_PORT` on module 4     |
| C     | The completion hook and the sweeper (3.2)                                |
| D     | Pro earnings views — live, and readable while suspended                  |
| E     | Incentive evaluation: `jobs_count`, `rating`                             |
| F     | Payout batching, approval, and the two permissions                       |
| G     | `RazorpayXClient` + disbursement with reference capture                  |
| H     | Reversal → deduction, including incentive unwinding (3.4, 3.5)           |
| I     | Specs + swagger contract e2e + a cURL script                             |
| J     | Docs — conflicts #45+, status report                                     |

Phases B, F and G each touch a file this module does not own — module 4's ports,
module 1's permission codes. Each is its own commit, as in module 7.

---

## 8 · Definition of done

- [ ] Editing a service's rate provably does not restate a completed job's pay
- [ ] Duration is recorded and provably **not** read by the calculation (#18)
- [ ] A job with no verified start earns no commission (3.3)
- [ ] A completed job whose commission write fails is found and fixed by the sweeper, not lost
- [ ] A reversal after payment becomes an itemised deduction; **no bank debit exists anywhere in the code**
- [ ] The same reversal cannot deduct twice
- [ ] A reversal unwinds the incentive progress it contributed to
- [ ] Approval and disbursement are separate permissions, neither on `ops`
- [ ] Commissions are marked paid only when disbursement **confirms**, never on submission (US-8.11)
- [ ] A suspended Pro can still read their payouts
- [ ] The app boots and everything but disbursement works with **no RazorpayX credentials**
- [ ] An incentive of an unevaluated type reports that clearly rather than silently never paying
