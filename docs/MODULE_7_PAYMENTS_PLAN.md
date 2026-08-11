# Module 7 — Payments · Implementation Plan

**Date:** 2026-08-11
**Status:** ✅ **Built.** Every phase A–J landed. Conflicts #35–41 recorded, #13
reversed by #37.

> Two things changed during the build and are worth knowing before reading the
> plan as a description of the code:
>
> - **`PaymentsPort` gained a third method.** Feature 11's cash gate has to be
>   asked at booking creation, inside module 4, and module 4 cannot import
>   module 7. `assertCashAllowed` goes through the port like the other two, and
>   the no-op answers permissively so cash keeps working with no gateway.
> - **Feature 16 cost module 5 slightly more than one `where` clause.** It is
>   an optional parameter on `findEligiblePros` plus the call site that fills
>   it — still one concept, still confined to two files, still its own commit.

Written against [`Modules_and_Features 1.md`](Modules_and_Features%201.md) §7, the
ground-rules table, [`ERD_DATA_MODEL_V10.md`](ERD_DATA_MODEL_V10.md) scope 02-D,
and [`CONFLICTS_AND_DECISIONS.md`](CONFLICTS_AND_DECISIONS.md) #13 and #20.

> Module 4 already defines the interface this module implements — `PaymentsPort`,
> currently bound to a no-op that **throws** on `createOrder`. Landing module 7
> is swapping one `provide` line plus the delegate hook, not threading payment
> through the booking lifecycle.

> **This is the first module that touches real money.** Two rules override
> convenience everywhere below: a client-reported success is never trusted, and
> Razorpay — not this database — is the store of record for what was attempted.

---

## 1 · Where the code stood before this module

_Kept as written at planning time. Every ❌ and **Absent** below has since been
addressed — see §8 and the status report._

| Thing                               | State                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/modules/payments/`             | **Does not exist.**                                                                                             |
| `Order`                             | **Does not exist in `schema.prisma`.** ERD defines all 22 columns; none are migrated.                           |
| `PaymentsPort`                      | ✅ Defined by module 4 — `createOrder`, `initiateRefund`. The seam is ready.                                    |
| `NoOpPaymentsService`               | ⚠️ Has **no `register()`** — unlike `NoOpDispatchService`. The delegate hook must be added (see 2.9).           |
| `BookingsModule` exports            | ⚠️ Exports `DISPATCH_PORT` but **not** `PAYMENTS_PORT`. One line, module 4.                                     |
| `Booking.paymentMode`               | ✅ Frozen at creation, forks the state machine (`booking.types.ts`), `awaiting_payment` guarded on `online`     |
| `Booking.paymentStatus`             | ✅ Present, written once at creation (`unpaid`) and never again. Module 7 becomes its only other writer.        |
| `Booking` cash columns              | **Absent** — `cashCollectedAmount` / `cashCollectedAt` are named by §7 but exist in neither the ERD nor Prisma. |
| `Pro.cashInHand`                    | **Absent** — same. Nor is there any handover record anywhere.                                                   |
| `Service.allowsCash`                | **Absent by decision** — conflict #13 declined it and deferred the call to this module.                         |
| `Customer.razorpayCustomerId`       | ✅ Column exists, unique, never written. Feature 9 is its first writer.                                         |
| `LedgerEntry` / `ReconciliationRun` | **Do not exist** — module 9. Features 14, 10 and 18 depend on them.                                             |
| Cancellation refund path            | ✅ `booking-cancellation.service.ts` computes the amount and calls `initiateRefund`. Nothing executes it.       |
| Raw request body                    | ❌ `main.ts` does not enable it. Webhook signature verification cannot work without it (2.3).                   |
| Razorpay SDK / HTTP client          | ❌ Not a dependency. `fetch` and `node:crypto` are (2.8).                                                       |

The seam module 4 built is genuinely ready. What is missing is the entire
storage layer for both modes and one shared-file change in `main.ts`.

---

## 2 · Contradictions and decisions

### 2.1 The cash mode has no store of record

The mode table names `Booking.cashCollectedAmount` as the store of record for
cash, and features 13–16 name three more things: `cashCollectedAt`,
`Pro.cashInHand`, and a handover with two actors and two timestamps.

**ERD v10 contains none of them.** Its `Booking` block stops at
`cancellationFeeAmount` / `refundedAmount`; its `Pro` block has `monthlySalary`
and nothing about cash; there is no handover table. The only trace of the whole
concept anywhere in the ERD is one comment on `LedgerEntry.debitAccount`:
`cash_in_hand:<proId>`.

Conflict #13 set the precedent — ERD wins, `allowsCash` not added — but its own
consequence paragraph routed this exact call here.

**Decision: add them.** #13 declined a _gate_ that `Booking.paymentMode` already
expressed. These are _storage_ with no alternative expression: without
`cashCollectedAmount` the mode table's store-of-record column does not exist,
and half of module 7 is unbuildable. Specifically:

| Add                                              | Why it cannot be derived                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `Booking.cashCollectedAmount`, `cashCollectedAt` | Named as the store of record. Nothing else records that money changed hands. |
| `Pro.cashInHand`                                 | Feature 16 gates dispatch on it — dispatch cannot afford a ledger aggregate. |
| `CashHandover` (new table)                       | Declare → confirm is two actors and two timestamps. No column can hold it.   |

`Pro.cashInHand` is a **cache of the ledger, not the ledger** — the same
relationship `Pro.completedJobs` already has to `Booking`. Module 9's nightly
rebuild is what makes it authoritative; feature 18's per-Pro reconciliation is
exactly that check.

### 2.2 Reopening conflict #13 — `Service.allowsCash` and the city gate

Feature 11 gates mode selection on `Service.allowsCash` **and** a city-scoped
setting, both server-side. #13 declined the column three days ago.

**Decision: add the city gate now, add the service column by agreement.**

The city gate costs no schema at all — `PlatformSettingsService.getString` already
resolves a city-scoped row over a global default, which is precisely feature 11's
shape. Key: `payments.cashEnabled`, default `true`, overridable per city.

`Service.allowsCash` is a **module 3 column**, so it is a coordination event, not
something this module adds unilaterally. It earns its place: the cash ceiling and
the uncollectable cancellation fee make cash a per-service risk lever (a ₹4,000
deep clean is not a ₹300 tap repair), and expressing that as seven
`payments.cashEnabled.service.<id>` settings rows would be a worse database than
one boolean.

**If the catalog owner declines,** fall back to the city gate alone and record it
— feature 11 degrades to city-scoped, which is enforceable and honest. Do not
smuggle per-service gating into a settings key.

### 2.3 Signature verification needs the raw body; Fastify has already parsed it

Feature 3 is the module's hard rule, and Razorpay's webhook HMAC is computed over
the **exact bytes** delivered. `JSON.parse` → `JSON.stringify` does not round-trip
key order or whitespace, so verifying against a re-serialised body fails
intermittently and unreproducibly — the worst possible failure for money.

`main.ts` creates the app without `rawBody`.

**Decision:** `NestFactory.create(AppModule, new FastifyAdapter(), { rawBody: true })`
and read `req.rawBody` in the webhook handler. This is a **shared-file change** —
its own small commit, announced, per the module-ownership rule.

### 2.4 The global ValidationPipe would reject every webhook

`VALIDATION_PIPE_OPTIONS` sets `whitelist` and rejects unknown properties — by
design, so a typo'd field fails loudly. Razorpay's webhook payload is a deep
object of _their_ fields, versioned by them, and it will grow.

**Decision: the webhook endpoint takes no DTO.** It reads the raw body, verifies
the HMAC, then parses and narrows what it needs. Applying `forbidNonWhitelisted`
to a third party's payload means their next release 400s every delivery.

The same reasoning does **not** apply to the checkout-verify endpoint (2.5) —
that body is ours, three known fields, and validates normally.

### 2.5 "Never trust the client" cuts deeper than signature verification

Feature 3 says verify the signature before treating a payment as successful. A
valid signature proves Razorpay produced that `order_id | payment_id` pair — it
does **not** prove the payment was captured, nor for how much. A signature is
replayable by the client that legitimately received it.

**Decision: signature verification is necessary, not sufficient.** The verify
endpoint (a) checks the HMAC, then (b) fetches the payment from Razorpay by id
and (c) asserts `status`, `order_id` and `amount` against our `Order` before any
state moves. The webhook is still the authority; verify exists to close the
checkout loop promptly, not to be a second source of truth.

### 2.6 Webhook idempotency without a table to hold event ids

Feature 5 requires duplicate deliveries to be safe. The ERD has no
`WebhookEvent` table, and adding one would recreate exactly the local copy of
gateway data the module's stated trade-off avoids.

**Decision: idempotency by convergent writes, with Redis as a fast path.**

1. Every write is **convergent** — the handler sets `capturedPaymentId`,
   `paymentMethod`, `paidAt`, `amountPaid` from the event payload, which is
   identical on every redelivery. Replaying it changes nothing.
2. `Order.status` and `refundStatus` move **forward only**, through a rank
   (`created < attempted < paid`; `none < initiated < settled`). A late
   `payment.authorized` arriving after `payment.captured` is ignored, not
   applied — Razorpay does not guarantee ordering.
3. `capturedPaymentId` is written **once**. A second, different payment id
   against a paid order is a duplicate-charge signal: log it loudly, do not
   overwrite, surface it in reconciliation.
4. Redis `setIfAbsent('rzp:evt:<event_id>', ttl)` short-circuits the common
   redelivery before any query runs.

Correctness rests on (1)–(3). Redis is an optimisation, so a cache flush replays
events harmlessly instead of corrupting an order.

### 2.7 A webhook must not 500 on a processing bug

`AllExceptionsFilter` turns any throw into a 500, and Razorpay retries non-2xx
for 24 hours. That retry is valuable when the failure is transient and poisonous
when it is a code bug — the same broken write, hammered.

**Decision:** verify the signature (401 on failure, and only there), then process
inside a try/catch that logs and returns 200. Retrying our own bug does not fix
it; the reconciliation route (feature 10) is what finds what we dropped.

### 2.8 Razorpay SDK, or six `fetch` calls

We use exactly six gateway endpoints: create order, fetch order, fetch payment,
fetch payments-for-order, create refund, create/fetch customer. Auth is HTTP
Basic. Node 24 has `fetch`; HMAC is `node:crypto`.

**Decision: a thin `RazorpayClient` inside the module, no new dependency.**
`package.json` is one of the two files that conflicts hardest between branches,
and the SDK's value here is thin. The trade is ours to own: retries, timeouts and
error mapping are hand-written, so they get a spec.

### 2.9 Module 4's payments no-op has no delegate hook

`NoOpDispatchService` has `register()`; `NoOpPaymentsService` does not — module 4
wrote the dispatch seam knowing module 5 was next, and left payments as a plain
stub. Nest resolves providers per module, so binding `PAYMENTS_PORT` inside
`PaymentsModule` will **not** reach `BookingsService`.

**Decision:** mirror the dispatch pattern exactly — add `register()` and a
`private real` to `NoOpPaymentsService`, export `PAYMENTS_PORT` from
`BookingsModule`, and have `PaymentsModule`'s constructor register
`RealPaymentsAdapter`. Two small edits in module 4, one commit, announced. Do not
invert the dependency by importing `PaymentsModule` into `BookingsModule`.

### 2.10 Who owns `Booking.paymentStatus`

Module 4 writes it once, at creation, as `unpaid`, and reads it in the
cancellation-refund decision. Module 7 needs to write it on capture, on refund
and on cash collection.

**Decision: module 7 owns `paymentStatus`, `cashCollectedAmount` and
`cashCollectedAt` after creation; module 4 keeps `status`.** The state machine in
`booking.types.ts` governs the _job_; payment is a parallel axis that only forks
it once, at `awaiting_payment`. Splitting on that line means neither module needs
a method on the other. The one crossing is capture → `assigning`, which goes
through `BookingStateService.transition` (already exported) so the status event
and its actor are recorded like every other transition.

### 2.11 Rupees here, paise there

`Order.amount` is `Decimal(12,2)` in rupees; Razorpay transacts in integer paise.
Every boundary crossing is a multiply or divide, and `Math.round(x * 100)` on a
float is how a customer gets charged ₹1,234.56 as ₹1,234.55.

**Decision:** one `toPaise` / `fromPaise` pair in `payments.money.ts`, converting
via the decimal string rather than float arithmetic, with a spec covering
trailing zeros, missing decimals and the largest value the column holds. No
inline `* 100` anywhere in the module.

### 2.12 Feature 16 gates dispatch, and dispatch is module 5

Once a Pro's balance breaches the ceiling, cash bookings stop being assigned to
them. Eligibility lives in `dispatch-scoring.service.ts`.

**Decision: module 7 owns the rule, module 5 owns one `where` clause.** Module 7
exposes `CashEligibilityService.blockedProIds()` / the ceiling setting; module 5
adds a single exclusion when `booking.paymentMode === 'cash'`. Announced,
one-line, its own commit.

Rejected: flipping `Pro.isAvailable` on breach. It would block the Pro's _online_
work too — punishing a Pro for carrying cash the platform asked them to carry.

### 2.13 The three things module 7 cannot finish

Features 14, 17, 10 and 18 all terminate in modules that do not exist:
`LedgerEntry` and `ReconciliationRun` (module 9), and support tickets (module 11).

**Decision: two more ports, owned by this module, in the shape module 4
established.**

- `LedgerPort` — `recordCashCollection`, `recordCapture`, `recordRefund`,
  `recordHandover`. No-op logs and returns. It fails **quietly**, unlike
  `createOrder`: a missing ledger entry does not make the money wrong, and
  refusing to collect cash because module 9 is absent would be worse.
- `SupportPort` — `raiseBillingTicket(bookingId, reason)`. Same shape.

Feature 10's reconciliation is **not** deferred — the cross-check itself is
implementable today as an admin route that fetches from Razorpay by order id and
reports variance. Only the `ReconciliationRun` _row_ waits for module 9.

### 2.14 Booting without payment credentials must stay possible

Cash is the default `paymentMode` and the whole lifecycle runs on it today.

**Decision:** `buildRazorpayOptions` returns `undefined` when the keys are
absent, rather than throwing the way `buildRedisOptions` and `buildS3Options` do.
With no keys, `RealPaymentsAdapter` never registers, the no-op stays bound, and
online booking keeps returning its existing honest 501. Cash is untouched. A
developer without gateway keys still runs the full product.

---

## 3 · Schema

### New: `Order` — all 22 ERD columns, online only

```prisma
model Order {
  id        String   @id @default(uuid()) @db.Uuid
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// A booking may have several orders — voided, reissued after expiry.
  bookingId  String   @db.Uuid
  booking    Booking  @relation(fields: [bookingId], references: [id], onDelete: Restrict)
  customerId String   @db.Uuid
  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Restrict)

  /// The key for every gateway lookup, including support's.
  razorpayOrderId String @unique
  /// Our reference sent to Razorpay. `<bookingNumber>-<n>`.
  receipt         String @unique

  /// Rupees. Razorpay transacts in paise — see payments.money.ts.
  amount     Decimal @db.Decimal(12, 2)
  amountPaid Decimal @default(0) @db.Decimal(12, 2)
  amountDue  Decimal @db.Decimal(12, 2)
  currency   String  @default("INR")

  /// created | attempted | paid — forward only (see 2.6).
  status String @default("created")

  /// Mirrors of the gateway, for triage only. The attempt list itself is
  /// fetched from Razorpay by razorpayOrderId and is not stored here.
  attempts    Int     @default(0)
  failureCode String?

  /// The successful attempt's reference — written once, never overwritten.
  capturedPaymentId String?   @unique
  paymentMethod     String?
  paidAt            DateTime?

  /// rzp notes: bookingId, serviceId, cityId.
  notesJson Json?

  /// CUMULATIVE across refunds, never per-refund.
  refundAmount     Decimal? @db.Decimal(12, 2)
  razorpayRefundId String?
  /// none | initiated | settled | failed — forward only.
  refundStatus     String   @default("none")
  refundedAt       DateTime?

  @@index([bookingId, createdAt])
  @@index([customerId, createdAt])
  @@index([status])
  @@map("orders")
}
```

### New: `CashHandover` — the only thing that clears a balance

```prisma
model CashHandover {
  id        String   @id @default(uuid()) @db.Uuid
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  proId String @db.Uuid
  pro   Pro    @relation(fields: [proId], references: [id], onDelete: Restrict)

  /// What the Pro says they are handing over.
  declaredAmount Decimal  @db.Decimal(12, 2)
  declaredAt     DateTime @default(now())

  /// declared | confirmed | rejected. Only `confirmed` moves cashInHand.
  status String @default("declared")

  /// What the admin actually counted. May differ from declared — the variance
  /// is the point, and it is never silently reconciled away.
  confirmedAmount   Decimal?   @db.Decimal(12, 2)
  confirmedAt       DateTime?
  confirmedByAdminId String?   @db.Uuid
  confirmedByAdmin   AdminUser? @relation(fields: [confirmedByAdminId], references: [id], onDelete: SetNull)

  rejectionReason String?
  notes           String?

  @@index([proId, status])
  @@index([status, declaredAt])
  @@map("cash_handovers")
}
```

### Altered

| Model       | Column                                             | Note                                 |
| ----------- | -------------------------------------------------- | ------------------------------------ |
| `Booking`   | `cashCollectedAmount Decimal? @db.Decimal(12,2)`   | 2.1 · store of record for cash       |
| `Booking`   | `cashCollectedAt DateTime?`                        | 2.1                                  |
| `Booking`   | `orders Order[]`                                   | back-relation                        |
| `Pro`       | `cashInHand Decimal @default(0) @db.Decimal(12,2)` | 2.1 · cache of the ledger            |
| `Pro`       | `cashHandovers CashHandover[]`                     | back-relation                        |
| `Customer`  | `orders Order[]`                                   | back-relation                        |
| `Service`   | `allowsCash Boolean @default(true)`                | **module 3 — needs agreement (2.2)** |
| `AdminUser` | `confirmedHandovers CashHandover[]`                | back-relation                        |

Two migrations, deliberately split: `add_payments_orders` (module 7's own tables
and columns) and `add_service_allows_cash` (the one module 3 column), so the
second can be dropped whole if 2.2 goes the other way.

### `PlatformSetting` seeds

| Key                                        | Default | Scope         |
| ------------------------------------------ | ------- | ------------- |
| `payments.cashEnabled`                     | `true`  | global + city |
| `payments.cashInHandCeilingAmount`         | `10000` | global + city |
| `payments.reconciliationVarianceTolerance` | `0`     | global        |
| `payments.orderValidityMinutes`            | `15`    | global        |
| `payments.webhookDedupeTtlDays`            | `7`     | global        |

Two of these are the numbers §7 says are undefined and carry the whole cash risk.
Giving them defaults does not resolve the risk — it makes it adjustable without a
deploy and visible in one place. The handover _cadence_ remains a human process
with no enforcement, and stays on the deferred list rather than being faked.

---

## 4 · Flows

### Online — checkout

```
POST /bookings/:id/payment/order
  ├─ assert paymentMode = online, status = awaiting_payment, no paid order
  ├─ ensure Customer.razorpayCustomerId (feature 9 — created, never stored beyond the id)
  ├─ Razorpay POST /orders  { amount: toPaise(flatPrice), receipt, notes: {bookingId, serviceId, cityId} }
  └─ persist Order(status=created) → return { razorpayOrderId, amount, currency, keyId }
```

### Online — capture

Two paths converge on the same convergent writer, and it does not matter which
arrives first:

```
webhook payment.captured          verify endpoint (client returns from checkout)
  └─ HMAC over rawBody              └─ HMAC over order_id|payment_id
       │                                 └─ fetch payment from Razorpay, assert amount + order
       └──────────────┬──────────────────┘
                      ▼
        Order: status=paid, capturedPaymentId, paymentMethod, paidAt, amountPaid
        Booking: paymentStatus=paid
        BookingStateService.transition → assigning   (first writer only)
        DispatchPort.requestAssignment                (module 4's own path)
        LedgerPort.recordCapture
```

`authorized` sets `paymentStatus = authorized` and nothing else. `failed` records
`failureCode` and `attempts`; the booking **stays** in `awaiting_payment` and
module 4's existing hold-window sweep is what eventually cancels it — module 7
does not cancel bookings.

### Online — refund

```
POST /admin/bookings/:id/refund  (or module 4's cancellation calling initiateRefund)
  ├─ Razorpay POST /payments/:capturedPaymentId/refund { amount: toPaise(x) }
  ├─ Order: refundStatus=initiated, razorpayRefundId, refundAmount += x
  └─ Booking: refundedAmount

… 5–7 working days …

webhook refund.processed
  ├─ Order: refundStatus=settled, refundedAt
  ├─ Booking: paymentStatus=refunded  (only when refundAmount = amountPaid)
  └─ LedgerPort.recordRefund
```

`refund.failed` sets `refundStatus = failed` and leaves `refundAmount` — a failed
refund that silently zeroed the cumulative total would hide money owed.

### Cash — collection and recovery

```
Pro, at the door:  POST /pros/me/bookings/:id/cash-collection
  ├─ assert paymentMode=cash, booking is the Pro's, status ∈ {started, completed}
  ├─ amount is NOT an input — it is flatPrice (feature 13)
  ├─ Booking: cashCollectedAmount, cashCollectedAt, paymentStatus=paid
  ├─ Pro.cashInHand += flatPrice          (atomic increment)
  └─ LedgerPort.recordCashCollection → cash_in_hand:<proId>

Pro, later:        POST /pros/me/cash-handovers   { declaredAmount }
Admin:             POST /admin/cash-handovers/:id/confirm { confirmedAmount }
  ├─ Pro.cashInHand -= confirmedAmount    (atomic, in the same transaction)
  └─ LedgerPort.recordHandover
```

Nothing else decrements `cashInHand`. Commission is never netted against it —
feature 15, and an explicit spec.

### Cash — the customer who will not pay

```
POST /pros/me/bookings/:id/cash-collection/decline  { reason }
  ├─ Booking: paymentStatus stays `unpaid`, cashCollectedAmount stays null
  ├─ completion proceeds normally (module 4 unchanged)
  ├─ SupportPort.raiseBillingTicket
  └─ commission untouched — the Pro is paid (feature 17)
```

---

## 5 · API surface

| Method | Route                                           | Actor                         | Feature |
| ------ | ----------------------------------------------- | ----------------------------- | ------- |
| `POST` | `/bookings/:id/payment/order`                   | customer                      | 1, 2, 9 |
| `POST` | `/bookings/:id/payment/verify`                  | customer                      | 3       |
| `GET`  | `/bookings/:id/payment`                         | customer                      | 6       |
| `POST` | `/payments/razorpay/webhook`                    | **none** — HMAC-authenticated | 4, 5, 8 |
| `POST` | `/pros/me/bookings/:id/cash-collection`         | pro                           | 13      |
| `POST` | `/pros/me/bookings/:id/cash-collection/decline` | pro                           | 17      |
| `GET`  | `/pros/me/cash-balance`                         | pro                           | 14, 16  |
| `POST` | `/pros/me/cash-handovers`                       | pro                           | 15      |
| `GET`  | `/pros/me/cash-handovers`                       | pro                           | 15      |
| `POST` | `/admin/bookings/:id/refund`                    | admin                         | 8       |
| `GET`  | `/admin/orders`                                 | admin                         | 7       |
| `GET`  | `/admin/orders/:id`                             | admin                         | 7       |
| `GET`  | `/admin/cash-handovers`                         | admin                         | 15      |
| `POST` | `/admin/cash-handovers/:id/confirm`             | admin                         | 15      |
| `POST` | `/admin/cash-handovers/:id/reject`              | admin                         | 15      |
| `GET`  | `/admin/payments/reconciliation`                | admin                         | 10, 18  |

Guards follow `pro-dispatch.controller.ts` — `JwtAuthGuard`, `ActorTypeGuard`,
`@RequireActorType`. The webhook route carries none of them and says so in its
JSDoc, because an unguarded route is the kind of thing a reviewer must see
explained rather than infer.

`GET /admin/orders/:id` returns our columns **and a link to the Razorpay
dashboard** for the same order. That is the stated trade-off honoured in the UI
rather than quietly worked around by copying attempt history locally.

### Files

```
src/modules/payments/
  payments.module.ts
  payments.types.ts              status ranks, event names, mode guards
  payments.money.ts (+ .spec)    toPaise / fromPaise — 2.11
  razorpay.client.ts (+ .spec)   six endpoints over fetch — 2.8
  razorpay.signature.ts (+ .spec) HMAC + timingSafeEqual — 2.5
  orders.service.ts (+ .spec)    create, reissue, convergent capture writer
  payment-webhook.service.ts (+ .spec)
  refunds.service.ts (+ .spec)
  cash-collection.service.ts (+ .spec)
  cash-handover.service.ts (+ .spec)
  cash-eligibility.service.ts    ceiling + city/service gate — 2.2, 2.12
  reconciliation.service.ts (+ .spec)
  real-payments.adapter.ts       satisfies module 4's PaymentsPort — 2.9
  ports/ledger.port.ts           module 9 seam — 2.13
  ports/support.port.ts          module 11 seam — 2.13
  payments.controller.ts  pro-payments.controller.ts  admin-payments.controller.ts
  payments-webhook.controller.ts
  dto/…
src/config/razorpay.config.ts (+ .spec)   — 2.14
```

---

## 6 · Deferred

| Item                                | Blocked on | Seam                                                 |
| ----------------------------------- | ---------- | ---------------------------------------------------- |
| Double-entry ledger rows            | Module 9   | `LedgerPort`, no-op logs                             |
| `ReconciliationRun` persistence     | Module 9   | Route computes and returns; nothing is stored        |
| Billing ticket on unpaid completion | Module 11  | `SupportPort`                                        |
| Payment-success push / receipt      | Module 12  | Nothing sends; `paidAt` is set                       |
| Invoice PDF on capture              | Module 10  | `Booking.invoicePdfUrl` stays null                   |
| Handover cadence enforcement        | undefined  | §7's own open question — not faked                   |
| Attempt history in the console      | **never**  | Deliberate. Razorpay dashboard, by `razorpayOrderId` |

---

## 7 · Build order

| Phase | Work                                                                                  |
| ----- | ------------------------------------------------------------------------------------- |
| A     | Schema: `Order`, `CashHandover`, Booking/Pro columns; two migrations; settings seeds  |
| B     | `razorpay.config`, `RazorpayClient`, signature verification, money conversion + specs |
| C     | Order creation and checkout handoff; `Customer.razorpayCustomerId` first write        |
| D     | Webhook — raw body in `main.ts` (own commit), convergent capture writer, idempotency  |
| E     | Verify endpoint; bind `PAYMENTS_PORT` to `RealPaymentsAdapter` via the delegate (2.9) |
| F     | Refunds — initiated on the call, settled on `refund.processed`                        |
| G     | Cash: mode gate, collection, decline path, `cashInHand`, handover declare/confirm     |
| H     | Cash ceiling → module 5's one `where` clause (own commit, announced)                  |
| I     | Reconciliation route, both scopes                                                     |
| J     | Specs + Swagger contract e2e; docs — status report, conflicts #29+                    |

Phases D, H and the `Service.allowsCash` half of A each touch a file this module
does not own. Each is its own commit, and none is folded into a feature change.

---

## 8 · Definition of done

- [x] A client-reported success with a valid signature but an uncaptured payment is **rejected** (2.5) — four specs, one per failure mode
- [x] The same webhook delivered five times leaves the order byte-identical — convergent writes, `paidAt` read from the row
- [x] `payment.authorized` arriving _after_ `payment.captured` does not downgrade the order
- [x] A second, different `capturedPaymentId` on a paid order is logged and refused, never overwritten — plus a unique index behind it
- [x] Webhook HMAC is computed over the raw body, proven by a spec with reordered JSON keys
- [x] A processing exception inside the webhook returns 200, not 500 (2.7)
- [x] No `* 100` outside `payments.money.ts`
- [x] Cash collection amount is not accepted from the Pro — no parameter exists, and a CHECK constraint enforces `= flatPrice`
- [x] `Pro.cashInHand` is moved by exactly two operations: collection and confirmed handover
- [x] Commission is provably never netted against `cashInHand` — the decline path writes neither
- [x] An unpaid completion still completes, still pays commission, and raises a ticket
- [x] A Pro over the ceiling receives online jobs and no cash jobs
- [x] The app boots, and cash bookings run end to end, with **no Razorpay keys set** (2.14) — verified against a real boot
- [x] `PAYMENTS_PORT` bound to the real adapter; module 4's services unchanged apart from `register()` and the cash gate
- [x] Reconciliation reports a seeded variance rather than silently balancing — and logs when it caps a scan

**Gate:** `typecheck` clean, `lint --max-warnings=0` clean, **373 unit tests**
(119 of them module 7's) and **130 e2e** passing, and the app boots with all 16
payment routes mapped.

---

## 9 · What is deliberately not finished

Recorded here rather than left to be discovered:

| Gap                                          | Why it is open                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Handover cadence**                         | #36(4). The ceiling caps exposure per Pro; nothing recovers it. No mechanism chases a Pro who never declares. Genuinely unresolved, and the feature list says so too |
| Ledger rows, `ReconciliationRun` persistence | Module 9. `LedgerPort` is called at all four points                                                                                                                  |
| Billing ticket delivery                      | Module 11. `SupportPort` is called; the booking columns are the durable record meanwhile                                                                             |
| Receipt / invoice on capture                 | Modules 10 + 12. `paidAt` is set; nothing renders or sends                                                                                                           |
| Cash cancellation fees                       | #36(3). Uncollectable by nature, not by omission                                                                                                                     |
