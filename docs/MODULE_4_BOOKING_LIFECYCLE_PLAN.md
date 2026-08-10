# Module 4 — Booking & Job Lifecycle · Implementation Plan

**Date:** 2026-08-10
**Status of this document:** plan only — no module 4 code has been written yet.

Written against [`Modules_and_Features 1.md`](Modules_and_Features%201.md) §4 and its
**Cancellation & Refund Flow** section, the ground-rules table that supersedes both,
[`ERD_DATA_MODEL_V10.md`](ERD_DATA_MODEL_V10.md), and the 24 US-4.x stories across
all three personas.

> **This is the largest module in the system and the only one that touches every
> other.** The scope document calls it "the spine". Two of its four hard
> dependencies — Dispatch (5) and Payments (7) — do not exist, so §6 proposes
> ports rather than waiting, and §2.1 draws the line between what genuinely
> ships now and what cannot.

---

## 1 · Where the code stands today

| Thing                   | State                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/modules/bookings/` | **Does not exist.**                                                                                                    |
| `Booking`               | Stub — 21 of the ERD's 42 columns. Created in the M6 pass purely so Pro counters and standing had something to count.  |
| `BookingStatusEvent`    | Stub — missing `lat`/`lng`, the two columns that make it dispute evidence.                                             |
| `RecurringPlan`         | **Does not exist.**                                                                                                    |
| `ChatMessage`           | **Does not exist.**                                                                                                    |
| `JobPhotoProof`         | **Does not exist.**                                                                                                    |
| `Service`, `City`       | ✅ Built (module 3). `assertBookable()` and `getDurationMinutes()` are waiting.                                        |
| `CustomerAddress`       | ✅ Built, with the in-flight-booking guard already stubbed against `Booking`.                                          |
| OTP provider            | ✅ Built — `SlideOtpProvider` from module 1 is directly reusable for the service-start OTP. No new integration needed. |
| S3 presigned upload     | ✅ Built — `S3Service` + the per-Pro key pattern from KYC/profile photos is directly reusable for `JobPhotoProof`.     |

Two things are already in place that materially shrink this module: **the OTP
provider** (feature 11–14) and **presigned S3 upload** (feature 17). Neither
needs new infrastructure.

Two things are missing that will bite: **there is no `Order`** (module 7) and
**nothing computes a free window** (module 5).

---

## 2 · Contradictions and open questions to settle

Nine items. Four are genuine document conflicts; five are questions the source
docs explicitly leave open (`**Open:**` in the stories). My recommendation is
given for each. **§2.1 and §2.2 change what gets built** and want your sign-off
before Phase A.

### 2.1 The module cannot be built end-to-end — but cash bookings can

Feature 1 says instant booking "dispatches immediately"; feature 4 says slot
availability is "answered by Dispatch from live roster and committed jobs".
Dispatch is module 5 and does not exist. Feature 8's state machine includes
`awaiting_payment`; Payments is module 7 and does not exist.

But the **Cash** ground rule cuts a clean line through this:

> A cash booking has **no `Order` row**, skips `awaiting_payment`, and
> dispatches before any money moves.

**Recommendation:** build the whole module behind two ports (§6), and scope the
deliverable honestly:

| Path                     | How far it runs today                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Cash booking**         | **End to end** — create → assign (ops-manual) → en route → arrived → OTP → started → completed → invoice |
| **Online booking**       | Stops at `awaiting_payment`. Everything past it is built and tested but unreachable                      |
| **Automatic assignment** | Ops assigns manually via an admin route. The port is there for module 5 to implement                     |
| **Scheduled slots**      | Accepted and stored; the slot **is not validated against real availability**                             |

That gives a genuinely demonstrable product — a cash job from tap to invoice —
rather than a half-module blocked on two others. The alternative is to wait for
5 and 7, which inverts the documented build order (phase 3 is Booking **and**
Dispatch together).

### 2.2 "Actual duration is the number commission is calculated from" — stale

Feature 18 reads:

> Actual duration computed from verified start to completion — **the number
> commission is calculated from**

The ground-rules table, module 8's own preamble, the ERD, and US-4.17 all
disagree:

> **US-4.17 Ripple:** My commission does not change. One rate per service — a
> four-hour job pays the same as a one-hour one.
> **ERD:** `actualDurationMinutes` — recorded for reporting, **no longer sets the rate**

**Recommendation:** identical to [conflict #7](CONFLICTS_AND_DECISIONS.md), of
which this is the last surviving fragment. `actualDurationMinutes` is computed,
stored and reported. It is **not** a commission input. Feature 18's final clause
is dead text.

### 2.3 The state machine is not linear — payment mode forks it

Feature 8 gives one path:

> `created → awaiting_payment → assigning → assigned → en_route → arrived → started → completed`

The Cash ground rule says cash **skips `awaiting_payment`** and dispatches
immediately. So there are two entry paths into `assigning`, decided by
`paymentMode`, which the ERD freezes at creation.

**Recommendation:** model it as a real state machine with an explicit transition
table (§7), not as an ordered list. `created → assigning` is legal for cash and
illegal for online; `created → awaiting_payment` is the reverse. One table, one
guard, tested exhaustively — this is the module's highest-value test surface.

### 2.4 Cancellation windows are a proposal, not policy

The Cancellation & Refund Flow section says so outright:

> The scope document does not define a cancellation policy, so the windows below
> are a proposal — **the timings and fee are business decisions, but the
> mechanics are not.**

**Recommendation:** build the mechanics exactly as specified (six windows, §8),
and put every number in `PlatformSetting` — `booking.cancellationFeeAmount`
(default `0`, per window D), `booking.paymentHoldWindowMinutes` (US-4.6),
`booking.noStartGraceWindowMinutes` (already named in module 14 as
`no_start.graceWindowMinutes`). No magic numbers, per the cross-cutting rule.

### 2.5 Recurring pricing — at plan creation or at generation? _(open in US-4.3)_

US-4.3 flags it as open and says "Currently the latter". The customer persona's
own summary table agrees:

> My booking is priced at the catalogue rate of that moment — recurring
> occurrences take the price when generated, not when the plan was made.

**Recommendation:** price at generation. It is already the documented default,
it needs no extra column, and it is the only option consistent with US-3.5
(a price change applies to future bookings). **Consequence to accept:** a
customer on a weekly plan can see their price move without acting. Notifications
(module 12) should tell them.

### 2.6 Rebook and the same Pro _(open in US-4.5)_

> If I explicitly want the same Pro, that conflicts with rotation. Unresolved;
> rotation currently wins.

**Recommendation:** rotation wins; a rebook copies service, address and
preferences but never pins `proId`. `rebookedFromBookingId` records the lineage
so a future preference feature has the data. No API surface for "same Pro".

### 2.7 When does chat close? _(open in US-4.8)_

> Chat must close some period after completion, or it becomes an unmonitored
> channel between strangers.

**Recommendation:** close it. `booking.chatWindowHoursAfterCompletion` in
`PlatformSetting`, default 24. Reads stay open forever — the thread is dispute
evidence (US-4.24) — writes stop. Enforced in the service, not the client.

### 2.8 Is the customer charged when they aren't home? _(open in US-4.15)_

> Whether I'm charged a fee is undecided. The Pro is salaried so nothing is owed
> to them, but a wasted visit is a real cost.

**Recommendation:** do not automate it. Record the arrival, the failed start and
the grace-window expiry; raise the internal `no_start` ticket; let ops decide
between cancel (window D, fee configurable) and reschedule. US-4.15's admin-side
entry says the same: _"route it to a human"_. The fee already exists as a
window-D setting, so no new mechanism is needed if policy later says charge.

### 2.9 The OTP-at-the-door override _(open in US-4.11)_

> If the person at the door isn't me — I sent a relative — the code still goes
> to my phone. **Support needs a documented override.**

**Recommendation:** an ops-only `POST /admin/bookings/:id/force-start` requiring
a reason, writing a `BookingStatusEvent` with `actorType = ops` and setting
`startedAt`. It must be **visibly distinct** from an OTP-verified start in the
event log, because the OTP is the trust anchor and a forced start is exactly the
thing a dispute will turn on. Gate it behind its own permission code.

---

## 3 · Schema

Module 4 owns five tables. One exists as a stub, one is half-built, three are new.

### 3.1 `Booking` — 21 columns to add

The stub carries identity, assignment and the three lifecycle timestamps. Per
ERD v10, these are missing:

```prisma
// Creation
bookingType           String   // instant | scheduled | recurring
recurringPlanId       String?  @db.Uuid
recurringPlan         RecurringPlan? @relation(...)
rebookedFromBookingId String?  @db.Uuid
rebookedFrom          Booking? @relation("Rebook", ...)
rebookedInto          Booking[] @relation("Rebook")
slotStartAt           DateTime?
slotEndAt             DateTime?

/// Frozen at creation — never recomputed from the live catalogue (US-3.2).
flatPrice             Decimal  @db.Decimal(12, 2)

// Payment — frozen at creation, forks the state machine (§2.3)
paymentMode           String   // online | cash
paymentStatus         String   @default("unpaid") // unpaid | authorized | paid | refunded

// Service-start OTP — the trust anchor
startOtpProviderRef     String?
startOtpAttempts        Int     @default(0)
startOtpVerifiedByProId String? @db.Uuid

// Execution
routeTrail            Json?    // sampled polyline, written ONCE at completion

// Invoice — an artifact of the booking, not a table
invoiceNumber         String?  @unique
invoicePdfUrl         String?
taxAmount             Decimal? @db.Decimal(12, 2)
invoicedAt            DateTime?

// Cancellation
cancelledAt           DateTime?
cancelReason          String?
cancelledByType       String?  // customer | ops | system — never `pro`
cancellationFeeAmount Decimal? @db.Decimal(12, 2)
refundedAmount        Decimal? @db.Decimal(12, 2)
```

Plus indexes for the two queries this module runs constantly:
`@@index([status, slotStartAt])` (the ops live board and the expiry job) and
`@@index([customerId, status])` (the customer's live-order view).

**One deliberate departure from the stub:** `flatPrice` is `NOT NULL`. Every
booking has a price from the instant it exists — there is no state in which one
does not. Making it nullable to ease the migration would permanently weaken the
guarantee US-3.2 depends on.

> Also add `expectedDurationMinutes` — snapshotted from `Service.durationMinutes`
> at creation. **This is not in the ERD.** It is proposed because a mid-plan
> change to a service's duration would otherwise silently resize a booking's
> slot (US-3.6 explicitly forbids that), and because dispatch needs the number
> the slot was sold against, not today's. Flag for ERD approval; if refused,
> derive it from `slotEndAt - slotStartAt` and accept that instant bookings have
> no record of it.

### 3.2 `BookingStatusEvent` — add the coordinates

```prisma
/// Where the actor actually was at the transition — dispute and SOS evidence.
lat Float?
lng Float?
```

**Use `Float`, not `Decimal`, despite the ERD saying `decimal`.** Every
coordinate already in this schema is a `Float` —
[`CustomerAddress.pinLat`](../prisma/schema.prisma#L210),
[`Pro.homeBaseLat`](../prisma/schema.prisma#L278) — so matching the ERD here
would make module 4's coordinates the odd ones out and break every comparison
against an address pin. This is a **pre-existing deviation from the ERD across
modules 2 and 6**, not one module 4 introduces; it should be recorded as its own
numbered conflict when this module lands, and either the ERD or all three
modules should move together. Do not fix it here.

Feature 9 says "capturing actor, timestamp **and coordinates** at every
transition"; the stub has no coordinates. Without them the event log is a
timeline, not evidence — and US-4.10's edge ("marking arrival from 3 km away is
recorded as such") is unenforceable.

**Feature 10 needs no schema at all.** "Repeat transitions preserved
(arrived → en_route → arrived)" falls out of an append-only log; what it forbids
is a unique constraint on `(bookingId, status)`. Do not add one.

### 3.3 `RecurringPlan`, `ChatMessage`, `JobPhotoProof` — new, per ERD

All three transcribe directly from the ERD with no open questions. Notes worth
carrying into the code:

- `RecurringPlan.nextRunAt` is the generator's cursor. A booking is generated
  **ahead of time**, not at slot time (US-4.3).
- `ChatMessage.senderType` is `customer | pro` only. Ops does not join the
  thread; ops reads it (US-4.24).
- `JobPhotoProof.lat`/`lng`/`capturedAt` are mandatory on `photoType =
completion`. That is the whole point — "geo-stamped: evidence, not decoration".

### 3.4 What module 4 does **not** own

`Review` (module 10), `AssignmentCandidate` (module 5), `Order` (module 7),
`SupportTicket` (module 11), `NotificationLog` (module 12). US-4.14's `no_start`
ticket and US-4.18's review are raised **through ports**, never written directly.

---

## 4 · API surface

### 4.1 Customer

| Method  | Route                            | Notes                                                     |
| ------- | -------------------------------- | --------------------------------------------------------- |
| `POST`  | `/bookings`                      | Instant or scheduled. Freezes price. Idempotency key (§5) |
| `POST`  | `/bookings/:id/rebook`           | Copies service/address; never pins the Pro (§2.6)         |
| `GET`   | `/bookings`                      | History, paginated                                        |
| `GET`   | `/bookings/live`                 | The live-order view                                       |
| `GET`   | `/bookings/:id`                  | Detail incl. status timeline                              |
| `GET`   | `/bookings/:id/tracking`         | Position + ETA **from Redis**, never from the booking     |
| `POST`  | `/bookings/:id/cancel`           | Window resolved server-side (§8)                          |
| `GET`   | `/bookings/:id/messages`         | Chat thread                                               |
| `POST`  | `/bookings/:id/messages`         | Write, refused after the chat window closes (§2.7)        |
| `POST`  | `/bookings/:id/start-otp/resend` | US-12.4 — a Pro is at the door; this cannot be a ticket   |
| `GET`   | `/bookings/:id/invoice`          | Number, tax, PDF url                                      |
| `POST`  | `/recurring-plans`               | Create                                                    |
| `GET`   | `/recurring-plans`               | List                                                      |
| `PATCH` | `/recurring-plans/:id`           | Pause / edit / end                                        |
| `GET`   | `/catalog/services/:id/slots`    | ⏸ **Blocked on module 5** — see §9                        |

### 4.2 Pro

| Method | Route                                     | Notes                                                        |
| ------ | ----------------------------------------- | ------------------------------------------------------------ |
| `GET`  | `/pros/me/bookings`                       | Assigned jobs                                                |
| `POST` | `/pros/me/bookings/:id/en-route`          | Coordinates required                                         |
| `POST` | `/pros/me/bookings/:id/arrived`           | Sets `arrivedAt`, **starts the grace clock**, issues the OTP |
| `POST` | `/pros/me/bookings/:id/verify-otp`        | The only thing that sets `startedAt`                         |
| `POST` | `/pros/me/bookings/:id/photos/upload-url` | Presigned S3, reusing the KYC pattern                        |
| `POST` | `/pros/me/bookings/:id/complete`          | **Refused without ≥1 completion photo** (US-4.16)            |
| `GET`  | `/pros/me/bookings/:id/messages`          | Same thread, Pro side                                        |

There is deliberately **no cancel route for a Pro.** Principle 2: a Pro cannot
cancel. Ops closes the assignment and dispatch re-runs.

### 4.3 Admin

| Method  | Route                             | Permission                                                   |
| ------- | --------------------------------- | ------------------------------------------------------------ |
| `GET`   | `/admin/bookings`                 | `booking.read`                                               |
| `GET`   | `/admin/bookings/:id`             | `booking.read` — the US-4.24 reconstruction screen, one call |
| `POST`  | `/admin/bookings/:id/assign`      | `dispatch.override` — manual assignment until module 5       |
| `POST`  | `/admin/bookings/:id/cancel`      | `booking.cancel`                                             |
| `POST`  | `/admin/bookings/:id/force-start` | `booking.force_start` (§2.9)                                 |
| `PATCH` | `/admin/bookings/:id/refund`      | ⏸ Blocked on module 7                                        |

**US-4.24 is an API design constraint, not a UI one:** _"every piece must be
readable from one screen. If reconstruction takes four tabs, disputes get
settled on the customer's word instead of the record."_ `GET
/admin/bookings/:id` must return the status timeline, photo proofs, chat thread
and route trail in **one response**.

---

## 5 · Business rules

| Rule                                                                             | Story / source | Failure mode if skipped                                        |
| -------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------- |
| Price frozen at creation from `Service.flatPrice`; never recomputed              | US-3.2, US-3.5 | A price edit silently rewrites what a customer agreed to       |
| `paymentMode` frozen at creation                                                 | ERD            | A cash booking growing an `Order` mid-flight                   |
| Only the transitions in §7 are legal; everything else is `409`                   | F#8            | A job "completed" that was never started                       |
| **Only a verified OTP sets `startedAt`**                                         | US-4.12        | Off-platform work and unprovable start times                   |
| A failed OTP increments `startOtpAttempts` and **does not** stop the grace clock | US-4.13        | An indefinite door-step stall with no ops visibility           |
| Completion refused without ≥1 `JobPhotoProof(completion)`                        | US-4.16        | No structured record of the finished work; disputes unwinnable |
| Completion refused unless `startedAt` is set                                     | F#13           | Duration computed from nothing                                 |
| `actualDurationMinutes` = `completedAt − startedAt`, **reporting only**          | §2.2           | Reintroducing duration-based pay                               |
| A Pro can never cancel; no route exists                                          | Principle 2    | Salaried employees declining work                              |
| Cancellation after `started` is ops-only                                         | US-4.21        | An automated percentage applied to a judgement call            |
| Never charge a cancellation fee when the platform failed to supply               | US-4.22        | Charging a customer for our own supply gap                     |
| `routeTrail` written **once**, at completion                                     | F#19, ERD      | An unbounded column rewritten on every GPS ping                |
| Chat writes refused after the close window; reads never                          | §2.7           | An unmonitored channel between strangers                       |
| `bookingNumber` unique, human-readable, generated server-side                    | F#7            | Support unable to identify a job over the phone                |
| Booking creation idempotent per `Idempotency-Key`                                | Cross-cutting  | A double-tap producing two jobs and two charges                |
| An address with an in-flight booking cannot be repointed                         | US-2.9         | **Already built** in module 2 — this module makes it reachable |

**`bookingNumber` format:** follow the `employeeCode` precedent — a Postgres
sequence behind a prefix, e.g. `HB-2026-000123`. Do not use a random string; the
whole point is a human reading it down a phone line.

---

## 6 · Cross-module wiring — the two ports

Module 4 depends on four modules, two of which do not exist. Rather than block,
define the seams as interfaces owned by module 4, with no-op implementations
that log. Modules 5 and 7 later provide the real ones and **nothing in module 4
changes**.

```ts
// DispatchPort — module 5 implements
requestAssignment(bookingId: string): Promise<void>;   // no-op: leaves status `assigning`
closeAssignment(bookingId: string, reason: string): Promise<void>;
getAvailableSlots(serviceId, addressId, date): Promise<Slot[]>;  // no-op: []

// PaymentsPort — module 7 implements
createOrder(bookingId, amount): Promise<{ orderId: string }>;    // no-op: throws for online
initiateRefund(bookingId, amount): Promise<void>;                // no-op: records intent only
```

Already-built collaborators need no port — they are real today:

| Consumer                                     | Call                                                          |
| -------------------------------------------- | ------------------------------------------------------------- |
| `ServiceCatalogService.assertBookable()`     | Refuse a booking against an inactive service                  |
| `ServiceCatalogService.getDurationMinutes()` | Slot sizing and the duration snapshot                         |
| `CustomersService` / serviceability          | Refuse a booking in an inactive city                          |
| `SlideOtpProvider`                           | **The service-start OTP** — no new integration                |
| `S3Service`                                  | `JobPhotoProof` presigned upload                              |
| `ProCountersService`                         | `completedJobs` increment on completion — **built, uncalled** |
| `RedisService`                               | Live position and ETA for the tracking view                   |

`ProCountersService` finally gets its caller here. It has been built and
unreachable since the M6 pass.

---

## 7 · The state machine

The single highest-value thing to get right, and the natural home of the module's
test suite. Model it as an explicit transition table.

```
                 ┌─ cash ──────────────────────────┐
created ─────────┤                                 ├──> assigning ──> assigned
                 └─ online ──> awaiting_payment ───┘                     │
                                                                         v
completed <── started <── arrived <──> en_route <────────────────────────┘
                                  (repeatable, US-4.9)

cancelled: reachable from every state except `completed` (§8)
```

Rules the table must encode:

- `created → assigning` **only** when `paymentMode = cash`; `created →
awaiting_payment` only when `online`.
- `awaiting_payment → assigning` only on a verified gateway callback — never on
  a client claim (US-7.6).
- `en_route ⇄ arrived` repeats freely. `arrivedAt` holds the **authoritative**
  first arrival; the log holds every one (US-4.9).
- `arrived → started` **only** via verified OTP or an ops force-start (§2.9).
- `started → completed` only with a completion photo present.
- `completed` is terminal. A completed job is disputed, never cancelled.

Every transition writes a `BookingStatusEvent` with actor, timestamp and
coordinates — in the same transaction as the status change, or the audit trail
can disagree with the booking.

---

## 8 · Cancellation

Six windows, exactly as specified. The mechanics are settled; only the timings
and the fee are business decisions (§2.4).

| Window | From status                   | Refund                                            | Fee                         | Commission          |
| ------ | ----------------------------- | ------------------------------------------------- | --------------------------- | ------------------- |
| **A**  | `created`, `awaiting_payment` | nothing charged                                   | none                        | none                |
| **B**  | `assigning`                   | 100%                                              | none                        | none                |
| **C**  | `assigned`                    | 100%                                              | none                        | none                |
| **D**  | `en_route`, `arrived`         | 100% less fee                                     | configurable, **default 0** | none                |
| **E**  | `started`                     | partial, **ops only**                             | ops decision                | only if ops directs |
| **F**  | `completed`                   | **not a cancellation** — dispute path (module 11) | —                           | reversed if upheld  |

Module 4's own responsibility is narrow and worth stating plainly: **own the
transition, the reason and the actor; write the status event.** It calls
`DispatchPort.closeAssignment` and `PaymentsPort.initiateRefund`; it does not
execute refunds, reverse commission or write ledger entries.

Windows A–D reverse no commission because `BookingCommission` is only written on
completion — there is nothing to unwind.

---

## 9 · Deferred, and why

| Item                            | Blocked on         | Seam                                                     |
| ------------------------------- | ------------------ | -------------------------------------------------------- |
| Real slot availability (F#4)    | Module 5           | `DispatchPort.getAvailableSlots()` returns `[]`          |
| Automatic assignment (F#1, F#2) | Module 5           | `DispatchPort.requestAssignment()`; ops assigns manually |
| `awaiting_payment` → paid       | Module 7           | `PaymentsPort.createOrder()`                             |
| Refund execution                | Module 7           | `PaymentsPort.initiateRefund()` records intent only      |
| Commission on completion        | Module 8           | Completion emits the event; nothing consumes it yet      |
| Live position / ETA (F#15)      | Module 13          | Redis keys exist; ETA computation does not               |
| `routeTrail` sampling (F#19)    | Module 13          | Nothing accumulates a GPS trail today — see §10.4        |
| Push on every transition        | Module 12          | Transitions emit events; no dispatcher listens           |
| `no_start` ticket (US-4.14)     | Module 11          | Grace-window job detects it; no ticket table to write to |
| Invoice PDF (F#21)              | No PDF tooling yet | Number, tax and `invoicedAt` are computable now          |
| Review (US-4.18)                | Module 10          | `Review` is stubbed; module 10 owns it                   |

---

## 10 · Risks

1. **Scope.** This is 22 features, 5 tables and ~35 endpoints — larger than
   modules 1, 2, 3 and 6 put together. It should be **several commits and
   probably several PRs**, phased per §11. Attempting it as one change is the
   main way this goes wrong.
2. **The migration is additive but large.** 21 new columns on a table that
   already has rows in any seeded environment. `flatPrice NOT NULL` needs a
   backfill or an empty table — check before writing it, exactly as with module
   3's FK tightening.
3. **`routeTrail` has no source.** Feature 19 wants a sampled polyline, but
   module 6's location ingest only writes _current_ position to Redis GEO and
   cold-flushes a single lat/lng. Nothing accumulates a trail. Either module 4
   starts appending to a Redis list on each ingest (cheap, but it edits module
   6's ingest path) or feature 19 defers to module 13. **Recommend deferring**
   and saying so, rather than shipping an always-null column that looks built.
4. **Idempotency is easy to get wrong under Fastify.** Booking creation, the OTP
   verify and completion all need it. A retried completion that double-increments
   `completedJobs` is a counter-drift bug that only surfaces in the nightly
   rebuild.
5. **Timezones.** `slotStartAt` is absolute, but a customer picks a wall-clock
   time in `City.timezone`. Every scheduled-booking bug in this class comes from
   storing the wrong instant. Convert at the edge, store UTC, and test across a
   DST-free zone (`Asia/Kolkata`) _and_ one with DST, because module 13's
   geocoder does not guarantee India-only forever.
6. **The chat thread is PII.** Neither side may see the other's number. Do not
   include phone fields in any chat DTO — the Pro/customer DTO separation from
   module 6 is the precedent to copy.

---

## 11 · Build order

Each phase is a commit; A, B and F are natural PR boundaries.

| Phase  | Work                                                                                          | Ships                          |
| ------ | --------------------------------------------------------------------------------------------- | ------------------------------ |
| **A0** | Reconcile §3 against the ERD; get a ruling on `expectedDurationMinutes`                       | —                              |
| **A1** | Schema: `Booking` columns, `BookingStatusEvent` coords, 3 new tables; migration               | ⚠️ shared `prisma/`            |
| **A2** | `bookingNumber` sequence, mirroring `employee_code_sequence`                                  | ⚠️ shared `prisma/`            |
| **B**  | The state machine + transition guard + status-event writer, with its full test matrix         | The module's spine             |
| **C**  | Creation: instant, scheduled, rebook, price freeze, idempotency; both ports as no-ops         | Bookings exist                 |
| **D**  | Pro lifecycle: en route, arrived, **start OTP**, completion + photo proof                     | **A cash job runs end to end** |
| **E**  | Cancellation, six windows, `PlatformSetting`-driven fee                                       | Close-out                      |
| **F**  | Chat, live-order + history views, the one-call US-4.24 admin reconstruction                   | Support can work               |
| **G**  | Recurring plans + the generator job                                                           | Retention                      |
| **H**  | Invoice number, tax, `invoicedAt` (PDF deferred)                                              | Close-out                      |
| **I**  | Specs for every §5 rule and every §7 transition; Swagger contract e2e, as module 3 has        | Verification                   |
| **J**  | Update `MODULE_STATUS_REPORT.md` + `CONFLICTS_AND_DECISIONS.md` (§2 becomes conflicts #18–26) | Docs                           |

Phase **D is the milestone worth aiming at** — it is the first point where the
product does something a customer would recognise.

---

## 12 · Definition of done

- [ ] §3 reconciled against the ERD, deviations recorded as numbered conflicts
- [ ] All 22 features built or explicitly deferred with a named blocker
- [ ] All 24 US-4.x stories audited in the status report, as module 3's were
- [ ] Every §7 transition — legal and illegal — has a test
- [ ] Only a verified OTP or an audited ops force-start can set `startedAt`
- [ ] Completion is impossible without a photo
- [ ] A Pro has no cancellation path at any layer
- [ ] `GET /admin/bookings/:id` reconstructs a disputed job in **one** call
- [ ] A cash booking runs create → complete → invoice against a real database
- [ ] `build && typecheck && lint && test && test:e2e` all clean
- [ ] cURL report in the style of the 2026-08-08 ones
- [ ] Both docs updated **in the same pass**, not after
