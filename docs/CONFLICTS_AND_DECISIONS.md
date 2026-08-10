# Conflicts & Decisions

Every place the source documents contradict each other, what we decided, and why.

**Why this file exists.** Homingo has four sources of truth that disagree:

| Source                                               | Authority                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Detailed_Scope_Home_Services_App_Suite.pdf` (5 Aug) | Original scope. Lowest authority — superseded wherever anything else differs |
| `Modules_and_Features 1.md` **ground-rules table**   | **Highest authority on behaviour.** Says so itself                           |
| `Modules_and_Features 1.md` **module feature lists** | Below the ground rules; some entries predate them and are stale              |
| **Eraser ERD v10** (team TheUnknownGMR)              | **Highest authority on schema shape** — column names, types, presence        |
| `user-stories-by-persona/*.md` (US-x.y)              | Authoritative on edge-case behaviour; same vintage as the ground rules       |

**The precedence rule this project runs on:** the **ERD wins on schema shape**;
the **ground-rules table wins on business rules**; the narrative feature lists
win only where nothing above them speaks.

Decisions here are binding. If one turns out wrong, change it here first.

---

## Index

| #   | Conflict                                                           | Module | Resolution                                                                                   |
| --- | ------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------- |
| 1   | `CustomerAddress.deliveryNotes`                                    | 2      | Removed — ERD has `landmark` only                                                            |
| 2   | Administrative audit trail                                         | all    | Deferred; `AdminAuditLog` dropped                                                            |
| 3   | DigiLocker KYC                                                     | 6      | Excluded — manual S3 + human review only                                                     |
| 4   | Pro status lifecycle missing `rejected`                            | 6      | `rejected` added                                                                             |
| 5   | Suspended Pro — `401` or `403`?                                    | 1/6    | `403`                                                                                        |
| 6   | "International format" phone accepted national numbers             | 1      | Canonicalise Indian mobiles to E.164                                                         |
| 7   | Duration → commission tiers                                        | 3      | **Cancelled** — duration feeds Dispatch only                                                 |
| 8   | "Per-city activation"                                              | 3      | Means `City.isActive`, not per-city services                                                 |
| 9   | Catalog edits "audited"                                            | 3      | No attribution at all — deferred with #2 and #14                                             |
| 10  | Category tree depth unspecified                                    | 3      | Two levels, enforced                                                                         |
| 11  | Price snapshotting with no `Booking` price column                  | 3/4    | Deferred to module 4; catalog exposes price                                                  |
| 12  | `Decimal` money serialises as a string                             | 3/6/8  | Accepted and documented, not coerced                                                         |
| 13  | `Service.allowsCash` named by a ground rule, absent from ERD       | 3      | Not added — ERD wins; cash gates on `Booking.paymentMode`                                    |
| 14  | Editor attribution on catalog rows                                 | 3      | Dropped — ERD has no such column                                                             |
| 15  | Catalog field names: plan vs ERD                                   | 3      | ERD names used verbatim                                                                      |
| 16  | Timestamps absent from the ERD, present everywhere in the schema   | all    | House convention kept                                                                        |
| 17  | US-3.4 creates a service "with commission" in one step             | 3      | Two calls — commission is a separate permission                                              |
| 18  | "Actual duration is the number commission is calculated from"      | 4      | **Cancelled** — reporting only, like #7                                                      |
| 19  | Coordinates: ERD `decimal`, codebase `Float`                       | 2/4/6  | `Float` kept; ERD deviation recorded, not fixed piecemeal                                    |
| 20  | Feature 8's linear state list vs the cash ground rule              | 4      | Real state machine; payment mode forks it                                                    |
| 21  | Recurring pricing — at plan creation or at generation?             | 4      | At generation                                                                                |
| 22  | Rebook vs rotation                                                 | 4      | Rotation wins; lineage recorded, Pro never pinned                                            |
| 23  | When does chat close?                                              | 4      | Writes close 24h after completion; reads never                                               |
| 24  | Is the customer charged when not home?                             | 4      | Not automated — ops decides                                                                  |
| 25  | The OTP-at-the-door override                                       | 4      | Audited ops force-start, visibly distinct on the timeline                                    |
| 26  | Cancellation windows are a proposal, not policy                    | 4      | Mechanics built; every number in `PlatformSetting`                                           |
| 27  | `Booking.expectedDurationMinutes` proposed but not in the ERD      | 4      | Not added — derived from the slot window instead                                             |
| 28  | Invoice tax: added to the price, or contained within it?           | 4      | Within — the customer sees one number only                                                   |
| 29  | Rule 2 needs travel time; Geo & Routing does not exist             | 5      | `TravelTimePort` + haversine — ranks, but never quotes an ETA                                |
| 30  | "Redis-queued intake" with no worker process                       | 5      | Real Redis list; drained by an admin route. The lock, not the trigger, is what makes it safe |
| 31  | US-5.5 supply gap vs US-5.10 exhaustion                            | 5      | Two outcomes — `no_supply` and `exhausted`                                                   |
| 32  | Module 5 cannot re-bind module 4's `DISPATCH_PORT`                 | 4/5    | The port is a delegate module 5 registers into                                               |
| 33  | `ProCountersService` methods duplicated work their callers now own | 5/6    | Counters own only counters; the caller owns the transition                                   |

---

## 1 · `CustomerAddress.deliveryNotes` — narrative doc vs ERD

**Module 2 · Resolved 2026-08-07**

Module 2 feature #4 says "Landmark **and** free-text delivery notes per address."
A `deliveryNotes` column was added on that basis. The ERD's `CustomerAddress`
carries `landmark` and nothing else.

**Decision:** ERD wins. The column was removed
(`20260807122120_remove_customer_address_delivery_notes`) and `landmark` serves
both purposes. Net schema effect across the two migrations: none.

**Consequence:** module 2 is 8/9 features, permanently, until the ERD adds the
column. This is the case that established the precedence rule at the top of this
file.

---

## 2 · Administrative audit trail — cross-cutting concern vs product decision

**All modules · Resolved 2026-08-08**

The cross-cutting concerns table promises audit on administrative mutation, and
US-3.5 / US-3.10 both say catalog edits are "audited". No audit table survived
into the active scope: `AdminAuditLog` was explicitly deferred pending schema,
retention and access decisions (`20260808230000_defer_admin_audit_log`).

**Decision:** do not invent the table — and do not invent a column either. Where
the ERD already gives a row an editor FK (`PlatformSetting.updatedByAdminId`),
use it; where it does not, record the gap rather than papering over it with a
column the diagram has never had.

**Consequence:** `BookingStatusEvent` remains the job-lifecycle trail, and
`PlatformSetting` records its last editor. Nothing else does — in particular the
catalog tables carry no attribution at all (conflicts #9 and #14). There is no
general admin-action audit, and the status report says so.

---

## 3 · DigiLocker KYC — scope PDF vs ground rules

**Module 6 · Resolved at build**

The original scope describes DigiLocker-backed identity verification. The
ground-rules table restricts the active scope to "**manual S3 upload and human
review only**. DigiLocker is deferred and is **not accepted by the API**."

**Decision:** ground rule wins. No DigiLocker fields, no DigiLocker upload path,
and the API rejects any attempt to claim a non-manual source.

---

## 4 · Pro status lifecycle is missing a state

**Module 6 · Resolved at build**

Feature #17 lists the lifecycle as `applied → under_review → approved →
suspended`. Feature #7 requires re-application: "a rejected applicant reapplies
as a new attempt; the earlier rejection and its documents are preserved." There
is no `rejected` state in the list to reapply _from_.

**Decision:** the feature list is incomplete, not restrictive. `rejected` was
added. A rejected applicant can authenticate but remains non-dispatchable, and
the prior attempt is preserved intact.

---

## 5 · Suspended Pro — `401` or `403`?

**Modules 1 + 6 · Resolved 2026-08-08**

The cURL suite initially asserted `401` for a suspended Pro presenting a valid
token. That conflates two different failures: the token _is_ valid and the
identity _is_ established.

**Decision:** `403`. Authenticated but forbidden. `401` is reserved for a
missing, malformed or revoked token. The test expectation was the thing that was
wrong, not the code.

**Consequence:** a suspended Pro retains read-only access to standing, jobs,
ratings, commissions, earnings and payouts — history they earned stays readable.

---

## 6 · Phone "international format" accepted national numbers

**Module 1 · Resolved 2026-08-08**

The documented contract said international format; the validator accepted a bare
10-digit Indian mobile, so the same human could exist under two identities
(`9876543210` and `+919876543210`) depending on which screen they used.

**Decision:** canonicalise at the DTO boundary (`dto/phone.transform.ts`). A
valid Indian national mobile is normalised to `+91…` before OTP dispatch, Redis
keys and persistence. Anything else must already be E.164.

---

## 7 · Duration → "tier selection in Commission"

**Module 3 · Resolved 2026-08-10**

Module 3 feature #7:

> Duration feeds two downstream systems: slot sizing in Dispatch and **tier
> selection in Commission**

Ground-rules table:

> **Commission rate.** One rate per Service (`commissionType`, `commissionValue`).
> No tiers, no duration bands, no per-city config. **Duration no longer changes
> what a Pro earns.**

Module 8's own preamble and US-3.10 both agree with the ground rule. Feature #7
is a leftover from when `CommissionTier` was a table in an earlier ERD revision.

**Decision:** ground rule wins. `Service.expectedDurationMinutes` feeds
**Dispatch slot sizing and ETA only**. No tier table, no duration band, no
`getCommissionTier()`. Feature #7 ships at half scope and the status report
records it as such.

**Consequence:** a long job and a short job of the same service pay identically.
If overrun compensation is ever wanted it must come from an incentive scheme
(module 8) or from splitting the service into two catalogue entries — which is
exactly the trade-off module 8's own note already calls out.

---

## 8 · "Per-city activation" — cities, or services per city?

**Module 3 · Resolved 2026-08-10**

Module 3 feature #5 reads "City registry with timezone; **per-city activation**",
which at a glance suggests activating individual services per city.

It does not, on four independent counts:

- the module map assigns module 3 exactly three tables — `ServiceCategory`,
  `Service`, `City`. There is no `ServiceCity` join table;
- **Pricing** ground rule: "One flat price per service, nationally";
- **Geography** ground rule: "City-level only. No micromarkets or zones";
- US-3.4: "**One flat national price.** No city pricing exists in the model."

**Decision:** "per-city activation" is `City.isActive`. Every active service is
bookable in every active city. Serviceability is answered by the city alone —
which is how module 2 already implements `GET /customers/me/serviceability`.

**Consequence:** launching a city is one boolean, and there is no way to withhold
a single service from a single city short of a schema change. Flagged as a
product risk rather than engineered around.

---

## 9 · Catalog edits are "audited", but there is no audit table

**Module 3 · Resolved 2026-08-10**

US-3.5 ("`Service.price` updated; audited") and US-3.10 both require audit.
See conflict #2 — there is no audit table.

**Decision:** do not invent a table, and — per conflict #14 — do not invent a
column either. ERD v10 gives the catalog tables no editor FK, so catalog
mutations carry no attribution at all for now.

**Consequence:** "who changed this price, and when, and from what" is not
answerable today, and neither is the weaker "who last changed it". This is the
sharpest open gap in module 3, and the status report says so.

> **Revised 2026-08-10.** An earlier draft of this entry recommended adding
> `updatedByAdminId` to `Service` and `ServiceCategory` as a partial answer.
> The ERD has no such columns; see conflict #14 for the reversal.

---

## 10 · Category tree depth is unspecified

**Module 3 · Resolved 2026-08-10**

Feature #1 says "parent/child nesting" without bounding the depth. Unbounded
nesting is trivial to store and expensive everywhere else — the browse response
becomes recursive, the SDUI home config (module 14) has to render arbitrary
depth, and US-3.8's "services must not be orphaned by a category deletion" grows
a subtree-walk.

**Decision:** **two levels.** A category is either a root (`parentId = null`) or
a child of a root. A category whose own parent is set may not itself become a
parent, enforced in the service layer with a `409`. The self-relation stays in
the schema, so allowing depth 3 later is a validation change, not a migration.

**Consequence:** "Home Cleaning → Deep Cleaning" works; a third level does not.
This matches every consumer-app catalogue in the category and keeps the browse
payload a fixed shape.

---

## 11 · Price snapshotting, with nowhere to snapshot to

**Modules 3 + 4 · Deferred 2026-08-10**

US-3.5 says "price is snapshotted onto `Booking` at creation" and US-3.2 says
"any screen showing a total must read the frozen `Booking.flatPrice`, not
recompute from the live catalog." `Booking` has **no price column at all** — the
model exists only as a stub for the counters modules 5/6/10 needed.

**Decision:** not module 3's to fix. Adding `flatPrice` to `Booking` without the
booking-creation flow that populates it would create a column nothing writes —
exactly the class of defect the 08-07 audit found on `Pro.monthlySalary`.

**Consequence:** module 4 must add `Booking.flatPrice` **and**
`Booking.expectedDurationMinutes` and populate both at creation. Until then,
editing a service price has no historical record to protect. Listed as an
inbound dependency in the status report.

---

## 12 · `Decimal` money serialises as a JSON string

**Modules 3, 6, 8 · Accepted 2026-08-08, reaffirmed 2026-08-10**

Prisma renders `Decimal` columns as strings, so `price` returns `"499.00"` and
`monthlySalary` returns `"18000"` — not numbers. This surprised the 08-07 cURL
run.

**Decision:** accept it and document it. The alternative — coercing to `number`
at the DTO boundary — reintroduces float error into money, which is the entire
reason the columns are `Decimal(12,2)`.

**Consequence:** every money field in Swagger is typed `string` with an example.
Clients must not `parseFloat` a total for display or arithmetic.

---

## 13 · `Service.allowsCash` — named by a ground rule, absent from the ERD

**Module 3 · Resolved 2026-08-10**

The **Cash** ground rule names the column outright:

> Pay-after-service in cash is supported, **where `Service.allowsCash` and the
> city allow it**.

ERD v10's `Service` has no such column — and no city-level cash flag either.
What it does have is `Booking.paymentMode` (`online | cash`, frozen at
creation), with the whole cash lifecycle described around that one field.

**Decision:** ERD wins, exactly as in conflict #1. `allowsCash` is **not**
added. Per-service cash gating does not exist in the data model.

**Consequence:** cash eligibility is currently a property of the booking, not
of the service — meaning any service can in principle be booked as cash. If
per-service or per-city cash control is genuinely wanted, that is an ERD change
plus a module 7 (Payments) decision, not something module 3 can smuggle in. The
ground rule's parenthetical is, for now, describing a capability the model does
not have.

---

## 14 · Editor attribution on catalog rows

**Module 3 · Resolved 2026-08-10**

The module 3 plan proposed `updatedByAdminId` on `Service` and
`ServiceCategory` as a cheap partial answer to conflict #9 — record at least
_who last touched the row_. ERD v10 gives neither table such a column.
(`PlatformSetting` has one; the catalog tables do not.)

**Decision:** dropped, and conflict #9's resolution is **revised**. No editor
column is added. Catalog mutations carry no attribution at all until module 15
decides on `AdminAuditLog`.

**Consequence:** "who changed this price?" is unanswerable today — not merely
"who changed it last". This is the sharpest open gap in the module and is
listed as such in the status report. The plan document's §2.3 recommendation is
superseded by this entry.

---

## 15 · Catalog field names — implementation plan vs ERD

**Module 3 · Resolved 2026-08-10**

`MODULE_3_SERVICE_CATALOG_PLAN.md` was written before the ERD was available in
this workspace and proposed names by inference. The ERD disagreed on six:

| Plan proposed             | ERD v10 (implemented) |
| ------------------------- | --------------------- |
| `expectedDurationMinutes` | `durationMinutes`     |
| `price`                   | `flatPrice`           |
| `allowsInstant`           | `supportsInstant`     |
| `allowsScheduled`         | `supportsScheduled`   |
| `allowsRecurring`         | `supportsRecurring`   |
| `parentId`                | `parentCategoryId`    |
| `displayOrder`            | `sortOrder`           |

The ERD also has no `slug`, `iconUrl` or sort column on `Service`, and no
`description` on `ServiceCategory`. All were dropped.

**Decision:** ERD names used verbatim, everywhere — schema, migration, DTOs and
API. The plan document's §3 is superseded by the shipped schema.

**Consequence:** anyone reading the plan should treat §3 as historical. The
authoritative shapes are `prisma/schema.prisma` and
[`ERD_DATA_MODEL_V10.md`](ERD_DATA_MODEL_V10.md).

---

## 16 · Timestamps the ERD does not draw

**All modules · Accepted, pre-existing**

No table in ERD v10 lists `createdAt`/`updatedAt` as columns, except where they
carry business meaning (`Customer.createdAt`, `PlatformSetting.updatedAt`).
Every model in `schema.prisma` has both.

**Decision:** keep the house convention. This predates module 3 — `City`,
`Role`, `Pro` and every other built table already carry them — and the ERD is a
domain diagram, not a DDL listing.

**Consequence:** a mechanical ERD-vs-schema diff will always show these two
columns as extra on every table. That is expected, not drift.

---

## 17 · US-3.4 creates a service "with commission"; US-8.4 wants them separated

**Module 3 · Resolved 2026-08-10**

US-3.4 describes creating a service in one step:

> **State:** `Service` with price, duration, category, **commission type and
> value**.

US-8.4 and US-3.10 pull the other way. US-3.10 is tagged for finance as well as
ops, and US-8.4 insists a repricing screen must make the commission mode
visible precisely because the two are different decisions:

> With `commissionType = flat`, a price cut cuts the platform's margin, not the
> Pro's pay. With `percent`, it cuts both.

**Decision:** separate them. `POST /admin/catalog/services` takes no commission
fields and creates a **draft**; `PATCH /admin/catalog/services/:id/commission`
sets the rate behind its own `catalog.commission.set` permission, seeded to
`finance` rather than `ops`. Two calls reach US-3.4's stated end state.

**Consequence:** an ops admin holding only `catalog.manage` cannot take a
service all the way to live on their own — finance has to set the rate first.
That is separation of duties on the number that determines Pro pay, and it is
deliberate. If it proves to be friction in practice, the fix is to grant `ops`
both codes in the seed, **not** to fold commission back into the create
payload — that would put pay rates behind the catalogue-editing permission.

---

## 18 · "Actual duration is the number commission is calculated from"

**Module 4 · Resolved 2026-08-10**

Module 4 feature 18 reads:

> Actual duration computed from verified start to completion — **the number
> commission is calculated from**

Four sources disagree. The ground-rules table ("duration no longer changes what
a Pro earns"), module 8's preamble, the ERD (`actualDurationMinutes` — "recorded
for reporting, no longer sets the rate"), and US-4.17 outright:

> My commission does not change. One rate per service — a four-hour job pays the
> same as a one-hour one.

**Decision:** the last surviving fragment of the dead `CommissionTier` model,
and cancelled like the rest of it (see #7). `actualDurationMinutes` is computed
at completion, stored, and used for reporting only. Nothing in module 4 exposes
it to a pay calculation.

**Consequence:** a Pro who works four hours on a ninety-minute job earns exactly
the ninety-minute rate. That is the employment model working as designed —
they are salaried, and commission is a per-service constant — but it is the
single most likely thing for a Pro to dispute, so the Pro App should not present
duration anywhere near earnings.

---

## 19 · Coordinates — ERD says `decimal`, the codebase uses `Float`

**Modules 2, 4, 6 · Recorded 2026-08-10**

ERD v10 types every coordinate as `decimal`. Every coordinate already in
`schema.prisma` is a `Float`: `CustomerAddress.pinLat/pinLng`,
`Pro.homeBaseLat/Lng`, `Pro.lastKnownLat/Lng`. This predates module 4.

**Decision:** module 4's new coordinates (`BookingStatusEvent.lat/lng`,
`JobPhotoProof.lat/lng`) use `Float`, matching the codebase rather than the
ERD. Making module 4 the one place that uses `Decimal` would mean coordinates
that cannot be compared against an address pin without a cast, which is worse
than a consistent deviation.

**Consequence:** a mechanical ERD-vs-schema diff shows this on eight columns
across three modules. It should be resolved **all at once** — either the ERD
adopts `float`/`double precision`, or all three modules migrate together. It is
explicitly _not_ module 4's to fix unilaterally.

---

## 20 · The state machine is not linear — payment mode forks it

**Module 4 · Resolved 2026-08-10**

Feature 8 gives one ordered path:

> `created → awaiting_payment → assigning → assigned → en_route → arrived → started → completed`

The **Cash** ground rule contradicts it directly: a cash booking "skips
`awaiting_payment` and dispatches before any money moves", and has no `Order`
row at all.

**Decision:** ground rule wins, and the feature list is implemented as a
**transition table** rather than an ordered list. `created → assigning` is legal
only for cash; `created → awaiting_payment` only for online. One guard
(`isTransitionAllowed`) enforces both, and every one of the 81 possible
(from, to) pairs is asserted in `booking.types.spec.ts`.

**Consequence:** `paymentMode` is frozen at creation and a `CHECK` constraint
bounds it to two values, because a third would silently break the fork and
every report that joins `Order`.

---

## 21 · Recurring pricing — at plan creation or at generation? _(open in US-4.3)_

**Module 4 · Resolved 2026-08-10**

US-4.3 flags it open and says "Currently the latter". The customer persona's own
cross-reference table agrees: "recurring occurrences take the price when
generated, not when the plan was made".

**Decision:** price at generation, from the live catalogue. It needs no extra
column and is the only reading consistent with US-3.5 — a price change applies
to future bookings.

**Consequence:** a customer on a weekly plan can see their price move without
doing anything. Notifications (module 12) should tell them when it does;
silently repricing a standing order is a churn event.

---

## 22 · Rebook and the same Pro _(open in US-4.5)_

**Module 4 · Resolved 2026-08-10**

> If I explicitly want the same Pro, that conflicts with rotation. Unresolved;
> rotation currently wins.

**Decision:** rotation wins. `rebook` copies the service, address and payment
mode, records `rebookedFromBookingId` for lineage, and **never** copies `proId`.
There is no API surface for requesting a particular Pro.

**Consequence:** a customer who liked their cleaner has no way to ask for them
again, and dispatch rule 3 will actively deprioritise that Pro for that address.
The lineage column is there so a future preference feature has the data, but
building one means changing the ranking rules, not module 4.

---

## 23 · When does the chat close? _(open in US-4.8)_

**Module 4 · Resolved 2026-08-10**

> Chat must close some period after completion, or it becomes an unmonitored
> channel between strangers.

**Decision:** writes close `booking.chatWindowHoursAfterCompletion` after
completion (default 24) and immediately on cancellation. **Reads never close** —
the thread is dispute evidence (US-4.24). Enforced server-side; a client-side
check protects nobody.

---

## 24 · Is the customer charged when they are not home? _(open in US-4.15)_

**Module 4 · Resolved 2026-08-10**

> Whether I'm charged a fee is undecided. The Pro is salaried so nothing is owed
> to them, but a wasted visit is a real cost.

**Decision:** not automated. The system records the arrival, every failed OTP
attempt and the grace-window expiry; ops decides between cancelling (window D,
where a fee already exists as a setting) and rescheduling. The admin-side
US-4.15 says the same — "route it to a human".

**Consequence:** if policy later says charge, no new mechanism is needed — set
`booking.cancellationFeeAmount` above zero. Nothing in the code has to change.

---

## 25 · The OTP-at-the-door override _(open in US-4.11)_

**Module 4 · Resolved 2026-08-10**

> If the person at the door isn't me — I sent a relative — the code still goes
> to my phone. **Support needs a documented override.**

**Decision:** `POST /admin/bookings/:id/force-start`, behind its own
`booking.force_start` permission, requiring a written reason of at least ten
characters. It writes a `start_otp_bypassed` event **before** the transition and
attributes the start to `ops`, not to the Pro.

**Consequence:** a forced start is visibly not an OTP-verified start on the
timeline, which is the whole point — a dispute over whether work was consented
to turns on exactly that distinction. The permission is granted to `support`
rather than `ops` in the seed, since it is a support action.

---

## 26 · Cancellation windows are a proposal, not policy

**Module 4 · Resolved 2026-08-10**

The Cancellation & Refund Flow section says so itself: "the timings and fee are
business decisions, but the mechanics are not."

**Decision:** build the mechanics exactly as specified — six windows, the actor
table, the four principles — and put every number in `PlatformSetting`:
`booking.cancellationFeeAmount` (default 0), `booking.paymentHoldWindowMinutes`,
`no_start.graceWindowMinutes`, `booking.chatWindowHoursAfterCompletion`,
`booking.startOtpMaxAttempts`, `booking.taxPercent`,
`booking.recurringGenerateAheadDays`.

**Consequence:** changing cancellation policy is a settings edit, not a
deployment. Two rules are **not** configurable and are enforced in code, because
they are principles rather than tunables: a Pro can never cancel, and the
platform never charges a fee for its own failure to supply.

---

## 27 · `Booking.expectedDurationMinutes` — proposed, then dropped

**Module 4 · Resolved 2026-08-10**

The module 4 plan proposed snapshotting the service duration onto the booking,
so a later catalogue edit could not retroactively resize a sold job (US-3.6).
ERD v10's `Booking` has no such column.

**Decision:** not added — the same ruling as #13 and #14. Instead, `slotStartAt`
and `slotEndAt` are set for **every** booking including instant ones, so
`slotEnd − slotStart` _is_ the duration the job was sold against. The guarantee
is preserved with columns the ERD already has.

**Consequence:** anything wanting the expected duration computes it from the
slot window rather than reading a field. Dispatch (module 5) should size slots
from `Service.durationMinutes` for new work and from the booking's own window
for committed work.

---

## 28 · Invoice tax — added to the price, or contained within it?

**Module 4 · Resolved 2026-08-10**

`Booking.taxAmount` exists in the ERD but nothing says whether the flat price is
tax-inclusive. US-3.2 and US-3.2b are unambiguous about what the customer sees:

> **US-3.2:** a single final number, so there are no surprises at the end.
> **US-3.2b:** I want the invoice to show ₹200 so that nothing is ambiguous.

**Decision:** the flat price is **tax-inclusive**. `taxAmount` records the GST
component _within_ it — `price − price / (1 + rate)` — not an addition to it.
The rate is `booking.taxPercent` (default 18).

**Consequence:** a ₹599 service invoices at ₹599 with ₹91.37 shown as the tax
component. Had tax been additive the customer would have been billed ₹706.82
after being quoted ₹599, which is precisely the surprise US-3.2 exists to
prevent. Finance should confirm this matches how the catalogue prices were set.

---

## 29 · Rule 2 needs travel time; Geo & Routing does not exist

**Module 5 · Resolved 2026-08-10**

Feature 6 ranks candidates by "computed travel time". Module 13 owns that and
is not built.

**Decision:** a `TravelTimePort` owned by module 5, with a haversine stand-in
that divides straight-line distance by `dispatch.assumedSpeedKmph` (default 20).

Unlike module 4's payments stub this one **deliberately returns a usable
answer**, because crow-flight distance ranks candidates correctly nearly always
at city scale — the ordering between a Pro 3 km away and one 20 km away does
not invert once you follow real roads.

**Consequence:** good enough to _rank_, not good enough to _quote_. Module 4's
tracking view still returns a null ETA rather than publishing a number derived
from this, and it should stay that way until module 13 lands.

---

## 30 · "Redis-queued intake" with no worker process

**Module 5 · Resolved 2026-08-10**

Feature 1 wants one queued job per booking. This codebase has no job runner —
module 4's recurring generator is an admin-triggered route for the same reason.

**Decision:** implement the queue for real (a Redis list, `RPUSH` on booking
creation) and drain it from an admin route. The per-booking `SET NX PX` lock is
what makes draining safe from anywhere, so the _trigger_ is not load-bearing
and swapping in BullMQ later replaces the drain loop only.

**Consequence:** assignment is asynchronous but not yet automatic — something
has to call the drain. That is a deployment concern, not a design one.

---

## 31 · A supply gap is not a dispatch failure

**Module 5 · Resolved 2026-08-10**

US-5.5 and US-5.10 describe different situations, and US-5.5 is explicit about
why conflating them is harmful:

> A structural supply problem dressed as a per-booking error will be triaged as
> a bug for months. Separate the two.

**Decision:** two outcomes. `no_supply` — nobody holds this service here at all,
Rule 1's pool was empty. `exhausted` — candidates existed and were all tried or
excluded. Different values, different ops queues, both surfaced by
`GET /admin/dispatch/unassignable`.

---

## 32 · Module 5 cannot simply re-bind module 4's `DISPATCH_PORT`

**Modules 4 + 5 · Resolved 2026-08-10**

Nest resolves providers per module. `BookingsService` lives in
`BookingsModule`, so it receives _that module's_ `DISPATCH_PORT` binding no
matter what `DispatchModule` declares. Verified empirically — the naive
approach left `BookingsService` holding the no-op.

Making `BookingsModule` import `DispatchModule` would work and would invert the
dependency the port exists to prevent.

**Decision:** the no-op is a **delegate**. It holds an optional real
implementation and forwards to it when present; `DispatchModule` registers the
real adapter into it at construction. Module 4 still imports nothing from
module 5, and the presence of `DispatchModule` in `AppModule` is the entire
switch between manual and automatic assignment.

**Consequence:** asserted in `test/module-graph.e2e-spec.ts`, because a
registration that silently failed would look exactly like a working system that
never assigns anything.

---

## 33 · `ProCountersService` methods duplicated work their callers now own

**Modules 5 + 6 · Resolved 2026-08-10**

Three of its four methods were written when module 4 and module 5 did not
exist, so each owned the _transition_ as well as the counter. As real callers
arrived, each one broke in the same way — silently:

| Method                  | What it also owned                          | How it failed                                                                                                                                 |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordCompletion`      | Set `status`/`completedAt`, wrote the event | Returned early on `status === 'completed'` — the state its caller hands it. `completedJobs` never moved                                       |
| `recordOffer`           | Created the winner's candidate row          | Used that row's existence as its idempotency guard; the engine writes it first, so it always returned early. `assignmentsOffered` never moved |
| `recordAcknowledgement` | Sets timestamps, event, counters            | Correct — but the _caller_ duplicated the update first, flipping `assignmentOutcome` off `pending_ack` so the counter refused its own work    |

**Decision:** counters own only counters. Each is now idempotent via its own
marker event rather than via a row some other module writes, and callers do the
transition. `recordOffer` upserts the candidate row with an empty `update` so
the engine's score inputs survive.

**Consequence:** every one of these was invisible to unit tests, which mock
Prisma and assert on calls. They surfaced only when a real caller met a real
database. Worth remembering when module 10 finally calls `recordReview` — it is
the one method that has still never run.

---

## 34 · A DTO documents the response; it does not filter it

**Module 3 · Found by cURL testing 2026-08-10**

`ServiceDto` correctly omits `commissionType` and `commissionValue`, and the
Swagger contract test asserted that it does. The **unauthenticated** catalogue
endpoints returned them anyway: the controller returns the Prisma row, the
response interceptor serialises whatever it is handed, and the
`@nestjs/swagger` plugin reads the DTO only to generate documentation.

US-3.2's ripple — "the platform/Pro split never appears on any customer-facing
surface" — was therefore violated on four public routes while the published
OpenAPI contract said otherwise.

**Decision:** customer-facing reads go through an explicit mapper
(`toPublicService`). DTOs stay documentation; filtering is code.

**Consequence, and the wider lesson:** a passing Swagger contract test proves
the _schema_ is right, not the _payload_. Any future endpoint that must withhold
a field needs a mapper and a test that inspects a real response body — which is
precisely what cURL testing caught and what unit tests, which mock the layer
below, structurally cannot.

---

## How to add to this file

One section per conflict, numbered, with: where the two sources disagree
(quote both), the decision, and the consequence you are accepting. Add a row to
the index. Update it **in the same pass as the code**, not afterwards.
