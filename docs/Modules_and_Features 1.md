# Home Services App Suite — Module & Feature Breakdown

**Derived from:** `Detailed_Scope_Home_Services_App_Suite.pdf` (5 Aug 2026), as amended by the data-model decisions in the ERD workspace (v9, 45 tables).

**Architecture:** one Node.js + Express backend, internally split into the modules below. Each module owns its tables and exposes a service interface; nothing reaches into another module's tables directly. This keeps the option of extracting a module into its own deployment later without forcing that cost now.

---

## Ground rules that override the original scope document

These supersede the PDF wherever they conflict. Every module below is written against them.

| Area | Ruling |
|---|---|
| **Auth** | Phone + OTP only, for all three user types. No email/password, no Google sign-in. OTP send and verify are handled by a third party (Synquic Slide / MSG91) — no OTP table exists. |
| **Dispatch** | The system assigns. A Pro **cannot accept or decline**. The only Pro action is **acknowledge**. Missing the ack window closes that attempt and the engine assigns the next-best candidate. |
| **Employment** | Pros are salaried employees. Salary is a recorded number for reference only — no salary cycle, no salary payout, no salary ledger entries. **Commission is the only Pro money this system computes.** |
| **Availability** | No roster. `Pro.isAvailable` is a straight on/off-duty flag **set by an admin, not by the Pro**; free windows derive from that Pro's committed bookings. |
| **Skill matching** | `ProService(proId, serviceId)` is the single source of truth. A Service is the unit of competency; there is no separate skill code. |
| **KYC** | Aadhaar + PAN only, held as columns on the application. Each is verified independently, and each records its own `source` — **`digilocker`** (issuer-signed, auto-verifiable) or **`manual`** (photographed, needs a human). Both paths stay open. |
| **Ratings** | **Two-way.** `Review.reviewerType` is `customer` or `pro`; the unique constraint is `(bookingId, reviewerType)`. Customer→Pro ratings drive dispatch. **Pro→customer ratings drive nothing automatically** — they surface to ops and to the next Pro sent there, and are never shown to the customer. |
| **Pricing** | One flat price per service, nationally. No per-city price table. |
| **Geography** | City-level only. No micromarkets or zones. |
| **Payments** | Razorpay for online. Instruments (cards, VPAs) stay at the gateway — the platform stores only references. |
| **Cash** | **Pay-after-service in cash is supported**, where `Service.allowsCash` and the city allow it. A cash booking has **no `Order` row**, skips `awaiting_payment`, and dispatches before any money moves. The Pro collects at the door and **hands the money back in full**; `Pro.cashInHand` tracks what they carry until a confirmed handover clears it. |
| **Cash vs commission** | **Never netted.** Commission is computed and paid identically in both modes — payment mode is not an input to pay. Cash-in-hand is a debt the Pro owes the platform, settled by handover; commission is a debt the platform owes the Pro, settled by payout. `CommissionPayout` has no cash field. |
| **Live state** | Pro GPS, booking ETA, dispatch locks, free-slot windows and the rotation lookup live in Redis, never in tables. |
| **Payment detail** | **No `Payment` table.** Attempt-level detail — every try, its failure code, the method used — lives at Razorpay and is looked up in **their dashboard** by `razorpayOrderId`. The admin console does not surface it. `Order` stores only what must be joined or reconciled on, plus refund state. |
| **Assignment** | **No `Assignment` table.** The live attempt lives on `Booking` (`proId`, `assignmentAttempt`, `ackDeadlineAt`, `assignmentOutcome`). Superseded attempts survive only in `AssignmentCandidate` and `BookingStatusEvent`. |
| **Commission rate** | **One rate per Service** (`commissionType`, `commissionValue`). No tiers, no duration bands, no per-city config. Duration no longer changes what a Pro earns. |
| **Pro availability** | **No shift roster.** `Pro.isAvailable` is a straight on/off-duty flag, **toggled by an admin** and audited like any other admin action. Free windows derive from that Pro's committed bookings alone. |
| **Pro standing** | **No quality audits.** Allocation is driven by **customer rating alone**, applied as a smoothed score so a Pro with few reviews is neither punished nor over-trusted. `acceptanceRate` is tracked for reporting and affects nothing. Quality concerns run through `SupportTicket` and are acted on via `ProService.isActive` or `Pro.status`. |
| **Cold start** | A Pro with no reviews is ranked at the platform average via a Bayesian prior — `dispatch.ratingPriorMean` and `dispatch.ratingPriorWeight` in `PlatformSetting`. No grace flag, no expiry, no schema change. |
| **Push tokens** | **No `DeviceToken` table.** `pushToken` / `pushPlatform` are columns on `Customer`, `Pro` and `AdminUser` — **one device per user**. A second login overwrites the first. |

---

## Module map

**38 tables across 15 modules.**

| # | Module | Owns | Primary consumer |
|---|---|---|---|
| 1 | Identity & Access | Role | All three apps |
| 2 | Customer Profile | Customer, CustomerAddress | Customer App |
| 3 | Service Catalog | ServiceCategory, Service, City | Customer App |
| 4 | Booking & Job Lifecycle | Booking *(job + assignment + invoice)*, RecurringPlan, BookingStatusEvent, ChatMessage, JobPhotoProof | Customer + Pro Apps |
| 5 | Dispatch Engine | AssignmentCandidate | Internal |
| 6 | Pro Management | Pro, ProApplication, ProService, ProBankAccount | Pro App + Admin |
| 7 | Payments | Order | Customer App |
| 8 | Commission & Payouts | BookingCommission, CommissionPayout, Incentive, ProIncentiveProgress | Pro App + Admin |
| 9 | Ledger & Reconciliation | LedgerEntry, ReconciliationRun, ReconciliationDiscrepancy | Admin (finance) |
| 10 | Training & Reviews | TrainingModule, ProTrainingProgress, OfflineTrainingSession, OfflineTrainingAttendance, Review | Pro App + Admin |
| 11 | Safety & Support | SosAlert, SupportTicket, TicketMessage | All three apps |
| 12 | Notifications | NotificationLog | Internal |
| 13 | Geo & Routing | *(none — Redis only)* | Internal |
| 14 | Config & Server-Driven UI | PlatformSetting, UiConfig | All three apps |
| 15 | Admin Console & Reporting | AdminJob, AdminAuditLog | Admin Panel |

**Held elsewhere, deliberately:** payment attempts (Razorpay) · the assignment record (a `Booking` column) · commission rates (a `Service` column) · push tokens (columns on the three user tables) · Pro availability (a `Pro` column) · live GPS, ETA, dispatch locks, free windows and rotation (Redis).

---

## 1. Identity & Access

Authentication and authorisation for customers, Pros and admins through one mechanism.

**Features**

1. Phone + OTP login and signup for all three user types
2. OTP dispatch and verification delegated to third party — codes are never generated or stored locally
3. Guest customer session created from device id on first app open
4. Guest → verified upgrade on phone attach, preserving saved addresses and browse history
5. Session issue, refresh and revoke; multi-device sessions per user
6. Admin role assignment; permission codes held as a json array on Role
7. Permission-check middleware on every admin mutation
8. City-scoped admin access — an ops user in Indore cannot act on Mumbai bookings
9. Account block / unblock for customers; suspend / reinstate for Pros
10. Rate limiting on OTP requests per phone number

**Depends on:** Notifications (OTP delivery channel)
**External:** Synquic Slide / MSG91

---

## 2. Customer Profile

Customer identity, contact details and the pinned addresses that dispatch routes to.

**Features**

1. Profile view and edit — name, optional email for invoice delivery
2. Multiple saved addresses per customer, labelled home / office / other
3. **Exact coordinate pinning**, stored separately from the text address — the Pro is routed to the pin, not the street name
4. Landmark and free-text delivery notes per address
5. Default address selection
6. City resolution from the pinned coordinate
7. Serviceability check before allowing a booking at an address
8. Razorpay customer object creation and linkage on first payment
9. Address edit history guard — an address referenced by an in-flight booking cannot be repointed mid-job

**Depends on:** Geo & Routing (reverse geocode, city resolution), Payments (gateway customer creation)

---

## 3. Service Catalog

The tree of what can be booked, and at what price.

**Features**

1. Category tree with parent/child nesting, display order and icons
2. Service definitions: name, description, expected duration, flat price
3. Booking-type flags per service — instant, scheduled, recurring — controlling which flows the app offers
4. Active / inactive toggling at both category and service level
5. City registry with timezone; per-city activation
6. Browse and search endpoints for the customer app
7. Duration feeds two downstream systems: slot sizing in Dispatch and tier selection in Commission
8. Catalog data feeds the Server-Driven UI home configuration

**Consumed by:** Booking, Dispatch, Commission, Server-Driven UI

---

## 4. Booking & Job Lifecycle

The service job from request through completion. The largest module, and the spine of the system.

**Features**

*Creation*
1. Instant booking — book now, dispatch immediately
2. Scheduled booking — pick a future slot from real Pro availability
3. Recurring plans — daily / weekly / fortnightly / monthly, auto-generating future bookings
4. Slot availability query, answered by Dispatch from live roster and committed jobs
5. Flat price quoted and frozen at booking time
6. One-tap rebook of any past booking
7. Human-readable booking number for support calls

*Lifecycle*
8. State machine: created → awaiting_payment → assigning → assigned → en_route → arrived → started → completed, with cancellation available throughout
9. Append-only status event log capturing actor, timestamp and coordinates at every transition — the audit trail behind every dispute
10. Repeat transitions preserved (arrived → en_route → arrived when a customer isn't home)

*Service-start OTP — the trust anchor*
11. OTP issued to the customer when the Pro marks arrival
12. Pro enters the code in the Pro App; verification via third party
13. **Only a verified OTP sets `startedAt` and begins the job timer** — this is what prevents off-platform work and disputed start times
14. Attempt counting and provider reference retained for audit

*Execution*
15. Live tracking view for the customer (position and ETA served from Redis)
16. In-app chat between customer and assigned Pro, scoped to the booking
17. Mandatory geo-stamped completion photo proof from the Pro
18. Actual duration computed from verified start to completion — the number commission is calculated from
19. Route trail written once at completion as a sampled polyline, for dispute evidence

*Close-out*
20. Cancellation with reason, actor type and timestamp recorded — behaviour depends on which window it falls in, see **Cancellation & Refund Flow**
21. Invoice generated on the booking — number, tax, PDF — showing only the flat price the customer agreed to
22. Booking history and live-order views

**Depends on:** Dispatch, Payments, Geo & Routing, Notifications
**External:** Third-party OTP provider

---

## 5. Dispatch Engine

Matching bookings to Pros. Runs the layered algorithm from Section 04 of the scope document, with the accept/decline step replaced by acknowledgement.

**The assignment itself is written onto `Booking`.** This module owns only `AssignmentCandidate` — the per-attempt audit of who was evaluated and why they won or lost.

**Features**

1. Redis-queued intake, one job per booking
2. Distributed lock per booking (`SET NX PX`) so a booking can never be double-assigned
3. **Rule 1 — availability.** Filter to Pros holding an active `ProService` for the service, with `status = approved`, `isAvailable = true` (admin-set), and a free window fitting the slot
4. Free-window computation from that Pro's **committed bookings alone** — there is no roster — cached in Redis per Pro per day
5. **Travel origin resolution** — last job's location if the Pro has a scheduled next job, otherwise current GPS, otherwise home base
6. **Rule 2 — proximity.** Rank by computed travel time from that origin to the customer's exact pin
7. **Rule 3 — rotation.** Deprioritise a Pro who served this household last time or serves it too frequently; an indexed query over `Booking(addressId, proId, completedAt)`, cached in Redis, with cooldown length from `PlatformSetting`
8. **Rule 4 — tie-break.** Expected job duration against the free window, then **smoothed rating**, then fewest assignments offered today, then lowest `Pro.id`
9. **Smoothed rating (cold-start handling).** `ratingScore = (ratingSum + priorMean × priorWeight) / (ratingCount + priorWeight)`, with both constants in `PlatformSetting`. A Pro with no reviews ranks at the platform average; each real review pulls the score toward the truth. **`acceptanceRate` is deliberately not a ranking input** — it would penalise Pros for undelivered pushes and provider outages
10. Every evaluated candidate persisted to `AssignmentCandidate` keyed `(bookingId, attemptNumber)` with rank, all score inputs and an exclusion reason — dispatch decisions stay explainable
11. Assignment written onto the booking and pushed to the Pro; `Pro.assignmentsOffered` incremented
12. **Acknowledgement window.** Pro taps to acknowledge; no accept or decline exists. On ack, `assignmentsAcknowledged` increments and `acceptanceRate` is recomputed **for reporting**
13. **No-ack retry.** Window expires → `assignmentOutcome = no_ack_timeout` → next-best candidate assigned as attempt N+1, with the failed Pro excluded as `already_tried`. The Pro's acceptance rate moves but their ranking does not
14. Ops manual override from the Live Dispatch screen, recorded on the booking with admin and reason
15. ETA computation, refreshed continuously and published to the customer
16. Unassignable bookings surfaced to ops with the full candidate rejection list

**Depends on:** Pro Management (availability, services), Geo & Routing (travel time), Booking (history for rotation), Notifications

> **Trade-off to know:** because only the current attempt lives on `Booking`, "this booking bounced through three Pros" is no longer a single-table read. Reconstruct it from `AssignmentCandidate` and `BookingStatusEvent`.

---

## 6. Pro Management

Recruiting, verifying and maintaining the workforce.

**Features**

*Onboarding*
1. In-app self-application, including referral attribution to an existing Pro or customer
2. Aadhaar and PAN capture by **either route, chosen per document**:
   - **DigiLocker** — OAuth consent, issuer-signed document fetched directly. `source = digilocker`, `digilockerRequestId` and fetch timestamp stored, and the document **auto-verifies** because nobody needs to assess a photograph of a card. Verifier recorded as `system`, never left null. Consent is per-fetch: pull once, keep the document, discard the token — no stored tokens for later re-fetch
   - **Manual upload** — photograph to S3, `source = manual`, human review. **This path never goes away**: DigiLocker only works if the applicant already linked those documents there, and many won't have
3. **Independent verification per document** — an admin can clear the Aadhaar and reject the PAN in one sitting, and tell the applicant exactly which to re-upload. Source and status are both per-document, so a DigiLocker Aadhaar and a photographed PAN coexist on one application
4. Admin onboarding queue with stages: pending → docs review → call pending → decision
5. Verification call logging
6. Approve / reject with reason
7. Re-application supported — a rejected applicant reapplies as a new attempt; the earlier rejection and its documents are preserved
8. Activation gate: only approved Pros become visible to the dispatch engine

*Profile & capability*
9. Pro profile with employee code and recorded monthly salary (reference only)
10. Home base coordinate, set at onboarding, used for supply planning and as fallback dispatch origin
11. **Service assignment** — which services this Pro may be dispatched for, with proficiency level
12. Per-service suspension: a failed audit on electrical work doesn't stop them taking AC jobs
13. Bank account details for commission disbursement

*Operations*
14. **Availability toggle** — `isAvailable` is a straight on/off-duty flag, **set by an admin**. There is no roster; free windows come from committed bookings
15. **Admin availability roster screen** — every approved Pro in a city with their flag, filterable, with bulk on/off. Without this, switching a workforce on each morning is a per-record chore
16. Live location ingest into Redis GEO; periodic cold flush to the Pro record as a fallback
17. Status lifecycle: applied → under_review → approved → suspended
18. **Acceptance rate** — `assignmentsAcknowledged ÷ assignmentsOffered`, maintained as exact counters and rebuilt nightly. **Reporting only** — it does not affect dispatch ranking or commission
19. Pro-facing profile, rating, acceptance rate and history views

**Depends on:** Catalog (services), Geo & Routing (location ingest), Admin Console (review queue, availability roster)

> **Note on "acceptance":** a Pro cannot decline. Acceptance rate measures **acknowledged in time**, not agreed-to — and it carries no consequence. It exists so ops can spot a Pro who repeatedly misses assignments and have a conversation, not so the system can quietly demote them. Ranking it would mean punishing Pros for undelivered pushes and provider outages.

> **Note on availability:** because only admins set `isAvailable`, ops carries the daily burden of switching the workforce on and off. Two things follow — there must be an inbound channel for "I'm unwell, take me off duty", and a decision on whether the flag auto-clears at end of day. Left on overnight, a Pro is dispatched work at 6am and times out on it.

---

## 7. Payments

Customer collection in **two modes**. **Razorpay is the store of record for online payment attempts** — the platform keeps only `Order`. Cash has no gateway and no `Order` row at all.

| Mode | `Booking.paymentMode` | When money moves | Store of record |
|---|---|---|---|
| Online | `online` | Before dispatch | Razorpay, via `Order` |
| Cash | `cash` | After completion, at the door | `Booking.cashCollectedAmount` |

**Features — online**

1. Razorpay order created server-side before checkout opens, carrying booking references in notes
2. Checkout handoff to the app with the order id
3. **Server-side signature verification before any payment is treated as successful** — a client-reported success is never trusted
4. Webhook handler for authorized / captured / failed / refunded, driving the booking's payment status
5. Idempotent webhook processing — duplicate deliveries are safe
6. On capture: `Order.status`, `capturedPaymentId`, `paymentMethod` and `paidAt` recorded — the successful attempt's reference, not the attempt history
7. `Order.attempts` and `Order.failureCode` mirror the gateway for triage; **the full attempt list is fetched from Razorpay by `razorpayOrderId` when support needs it**
8. Full and partial refunds with gateway reference captured, tracked through both states on `Order` — **initiated** on the call, **settled** on the `refund.processed` webhook 5–7 days later (see **Cancellation & Refund Flow**)
9. Saved instruments offered via the gateway customer object; no card or VPA data stored on the platform
10. Reconciliation cross-checks captured amounts against Razorpay by order id

**Features — cash**

11. **Mode selection at checkout**, gated on `Service.allowsCash` and a city-scoped setting, both enforced server-side. `Booking.paymentMode` is frozen at creation and cannot change
12. **Cash bookings skip `awaiting_payment`** and dispatch immediately — a Pro travels against an unpaid booking
13. **Collection at the door:** the Pro records it, setting `Booking.cashCollectedAmount`, `cashCollectedAt` and `paymentStatus = paid`. The amount is not editable — it is `flatPrice` or nothing
14. **`Pro.cashInHand`** accumulates what each Pro is carrying; ledger entries post to a `cash_in_hand:<proId>` account rather than a bank account
15. **Recovery by handover, never by netting** — the Pro declares a handover, an admin confirms it, and only then does the balance clear. Commission is untouched throughout
16. **Cash ceiling** — once a Pro's balance breaches it, cash bookings stop being assigned to them until they hand over
17. **Unpaid completion path** — a job the customer won't pay for still completes, raises a `billing` ticket, and **still pays the Pro their commission**
18. Cash-specific reconciliation: completed cash bookings vs collections recorded, and per-Pro balance vs ledger

**External:** Razorpay (online only)

> **Trade-off to know:** attempt-level questions — retries, duplicate charges — are answered from the **Razorpay dashboard**, not the admin console. Nothing is built here for it. In exchange, there is no local copy of payment data to drift out of sync with the gateway.

> **What cash costs, stated plainly.** Every guarantee online payment provides is inverted: money moves *after* the work, *in person*, into *the Pro's hand*. Four consequences follow, and three of them are unresolved.
> 1. **No `Order` row for cash.** Any report joining `Order` silently undercounts every cash booking. Most likely bug from this feature.
> 2. **`paymentStatus = paid` stops meaning "the platform has the money".** For cash it means an employee is carrying banknotes. Financial reporting must read `paymentMode` alongside it.
> 3. **Cancellation fees are uncollectable.** No instrument, no balance. Late cancellation is free for cash customers and costs a Pro's travel each time.
> 4. **Handover is the only thing that clears a balance.** Since commission never offsets it, a Pro who stops handing over accumulates indefinitely and no arithmetic notices. Two operational numbers carry the whole risk — the **`cashInHand` ceiling** and the **handover cadence** — and both are undefined.

---

## 8. Commission & Payouts

The only Pro compensation this system calculates.

**One rate per Service.** `Service.commissionType` (`percent` | `flat`) and `Service.commissionValue`. No tier tables, no duration bands, no per-city config — job length no longer changes what a Pro earns.

**Features**

1. Commission rate set on the service itself, edited by an ops or finance admin
2. Rate expressed as either a **percentage** of the flat price or a **flat amount**
3. Per-booking commission computed the moment the job completes
4. **Rate snapshotting** — `commissionType` and `commissionValue` are copied onto `BookingCommission` at computation, so editing a service tomorrow never rewrites what was paid yesterday
5. Platform share and Pro share both recorded against the booking
6. Deductions applied per job
7. Incentive schemes: job count, streak, rating threshold, surge slot — configured with criteria and reward
8. Incentive progress tracked per Pro, credited against the job that triggered it
9. Live earnings view in the Pro App — updates as jobs complete, no end-of-day wait
10. Payout batches per period, aggregating commission, incentives and deductions
11. Admin approval step before disbursement
12. RazorpayX disbursement with reference capture
13. Commission reversal on refunded or disputed jobs; if already paid out, it becomes a deduction on the next payout, never a clawback

> **Trade-off to know:** a long job and a short job of the same service now pay identically. If overrun compensation matters, it has to come from a different mechanism — an incentive, or splitting the service into two catalogue entries.

**Depends on:** Booking (completion + duration), Pro Management (bank account), Ledger
**External:** RazorpayX

---

## 9. Ledger & Reconciliation

The books. Everything financial lands here, and nothing here is ever edited.

**Features**

1. Append-only double-entry ledger with a hash chain linking each entry to its predecessor
2. Entry types: charge, refund, platform revenue, pro commission, deduction, incentive
3. Every entry carries typed references to booking, payment, payout, Pro and customer
4. **Nightly reconciliation** across the whole system, verifying every charge, commission and deduction against actuals
5. Discrepancy detection: missing ledger entries, amount mismatches, orphan transactions
6. Discrepancy resolution workflow with admin attribution and notes
7. The same nightly job rebuilds derived counters (Pro rating, completed job count) from source tables, so drift self-heals within 24 hours
8. Daily collections, payouts due and outstanding dues answered as queries over the ledger
9. Finance dashboards: what came in today, what's owed out, variance trend

**Depends on:** Payments, Commission

---

## 10. Training & Reviews

Making Pros competent, and capturing what customers thought.

**Features**

*Training — delivered in the Pro app*
1. Trade-level training modules: video, document, checklist or quiz, served by `contentUrl` and played **inside the app**
2. Trade-specific delivery — an electrician sees electrical procedures and checklists, derived from their assigned services
3. Per-Pro progress tracking with percent complete and quiz scores, **resumable from the last position** so an interrupted video isn't restarted from zero
4. Quiz attempt tracking with a capped retry policy — the score is the defensible signal, not percent watched
5. Mandatory-module gating before a Pro can be activated for a service
6. In-app access to reference material during a job, cached for poor connectivity
7. Download-on-wifi for video, so completion rates reflect willingness rather than data budgets
8. Offline session scheduling — venue, trainer, capacity — for client-run classroom and field training
9. Enrolment and attendance marking by an admin

*Reviews — both directions*
10. Customer reviews on completed bookings: star rating, comment, optional photos of the finished work, quick tags
11. **Pro reviews of the customer** on the same booking, distinguished by `reviewerType`, with a **controlled tag vocabulary** (`no_access`, `unsafe`, `pets_loose`, `payment_difficulty`, `pleasant`) rather than free text
12. `Customer.ratingSum` / `ratingCount` mirror the Pro counters and are covered by the same nightly rebuild
13. Pro-authored ratings surfaced to ops and on the job card of the next Pro dispatched there — **never to the customer**
14. Review moderation — hide abusive text or a photo that exposes the customer's home, with reason and admin attribution
15. Rating maintained as exact counters (`ratingSum` / `ratingCount`); the customer→Pro direction feeds the dispatch tie-break and the Pro's public profile

**Depends on:** Catalog (trade categories), Booking (review target)

> **Ratings are asymmetric on purpose.** Customer→Pro is public, feeds ranking, and materially changes how much work a Pro gets. Pro→customer is **internal, tag-based, and drives nothing automatically** — it warns the next Pro and gives ops a pattern to act on. Making it drive dispatch would mean a household quietly losing service with no explanation and no appeal.
>
> **Open:** what ops actually does about a badly-rated customer — warn, force online payment, block — is undefined. Collecting `unsafe` tags and acting on none of them is worse than not collecting them.

> **What changed:** there is no `ProQualityAudit`. The platform no longer runs its own scored assessment of a job. A Pro's standing rests on **customer rating**, and rating alone affects how much work they get — applied as a smoothed score rather than a raw average. `acceptanceRate` is tracked alongside it but changes nothing automatically. Quality concerns are raised as a `SupportTicket` with `category = quality` and acted on through `ProService.isActive` (suspend one service) or `Pro.status` (suspend entirely), with the outcome recorded in the ticket's `actionTaken`.
>
> The cost: no structured checklist, no comparable score across Pros, and no proactive auditing — quality problems now surface only when a customer complains.

---

## 11. Safety & Support

Two-sided SOS, disputes, and system-detected exceptions.

**Features**

*Safety*
1. **One-tap SOS from the customer** — for situations such as being alone at home and uncomfortable
2. **One-tap SOS from the Pro** — for a Pro in transit or on site who doesn't feel safe, or facing a dispute risk
3. Alert carries live location and a full snapshot of the booking context
4. Ops acknowledgement with response timestamp, then resolution or false-alarm closure
5. SOS alerts bypass normal ticket queuing

*Support*
6. Tickets raised by customer, Pro, or the system itself
7. Categories: billing, quality, dispute, app issue, no-start
8. Threaded conversation with internal-only notes invisible to the raiser
9. Priority and escalation
10. Assignment to a support admin, with resolution notes on close

*System-detected exceptions*
11. **No-start detection** — a Pro marks arrival but doesn't start within the configured grace window
12. Raised automatically as an internal ticket for ops, carrying the grace window that was applied
13. **Never surfaced to the Pro** — handled quietly, by design
14. Dispute resolution backed by booking evidence: status timeline with coordinates, photo proof, route trail, chat log

**Depends on:** Booking (evidence), Config (grace window), Notifications

---

## 12. Notifications

Every outbound message, across three channels.

**Features**

1. Push token read from `Customer.pushToken` / `Pro.pushToken` / `AdminUser.pushToken` — **one device per user**
2. Push via FCM (Android) and APNs (iOS)
3. WhatsApp for OTP and transactional messages
4. SMS fallback
5. Template-driven payloads with per-template channel routing
6. Event-driven triggers from Booking, Dispatch, Commission and Safety
7. Delivery status tracking with provider references
8. Per-booking notification history for support
9. Token cleared on provider rejection; the user must reopen the app to re-register

**External:** FCM, APNs, WhatsApp Business API, SMS gateway

> **Trade-off to know:** one token per user means a Pro who logs in on a second phone silently stops receiving pushes on the first. Since a missed push can expire an acknowledgement window and cost the Pro a job, the login flow must overwrite the token and the app must re-register on every launch.

---

## 13. Geo & Routing

Everything spatial. No tables of its own — Redis plus reads from Pro and CustomerAddress.

**Features**

1. Geocoding and reverse geocoding via OpenStreetMap, keeping per-request third-party cost near zero
2. Route and travel-time computation between two coordinates
3. Live Pro location ingest into a Redis GEO index
4. Proximity search over that index to build the dispatch candidate pool — one call instead of scanning the Pro table
5. ETA computation and continuous refresh during an active job, pushed to the customer over the websocket. **Never written to `Booking`** — it changes every few seconds
6. **Pre-dispatch ETA** shown on the booking screen before the customer commits — the best travel time among currently available Pros near the pin, cached briefly in Redis. An estimate, never a promise: no Pro is reserved at that point
7. **ETA-slip notification** when the estimate degrades past a configured threshold, with a cooldown so traffic lights don't generate a stream of pushes
8. Route trail sampling and polyline compaction at job completion
9. City resolution from a coordinate
10. Periodic cold flush of last-known position to the Pro record, so dispatch survives a Redis restart

**External:** OpenStreetMap (Nominatim / OSRM)

> **Cost note on the pre-dispatch ETA.** It runs on *browsing* traffic, not booking traffic — orders of magnitude more calls than dispatch itself. A full candidate ranking per page view is both a routing bill and a latency problem. Use a coarse radius query with cached travel times, and show a range rather than a number.

---

## 14. Config & Server-Driven UI

Changing behaviour and screens without shipping an app release.

**Features**

*Platform settings*
1. Key/value settings with optional per-city override
2. Covers every tunable the scope document calls configurable: no-start grace window, acknowledgement window, rotation cooldown, dispatch candidate pool size, review photo cap
3. **Plus the two cold-start constants** — `dispatch.ratingPriorMean` and `dispatch.ratingPriorWeight`. These decide how a Pro with few reviews ranks against an established one, so a change here redistributes work across the whole city. Treat editing them like editing a price
4. Change attribution and timestamp on every setting

*Server-driven UI*
5. Component-based home screen defined as a JSON tree
6. Served via CDN (CloudFront) with a single endpoint managing the tree
7. Versioning with publish and rollback
8. Per-user-context loading — segment and city determine what a given user sees
9. Cache invalidation on publish
10. Minimum app version gating per config
11. Layouts, categories and banners changeable without an app-store release

**External:** AWS CloudFront

---

## Externals added by these features

| Feature | Third party | Note |
|---|---|---|
| **DigiLocker document fetch** | DigiLocker (MeitY) | OAuth consent + issued-document API. Requires partner registration. Only works if the applicant has linked those documents |
| Training video delivery | CDN (CloudFront) | Video is the expensive content type on a metered connection — download-on-wifi matters for completion rates |

---

## 15. Admin Console & Reporting

The operations, support and finance surface.

**Features**

*Operations*
1. Role-based login and navigation — ops, support, finance, super admin
2. **Live dispatch map** with real-time booking-to-Pro state and manual override tools
3. Pro onboarding queue with document review and call logging
4. Booking management: status changes, cancellations, reassignment
5. Customer 360 and Pro 360 views — the Pro view shows rating, acceptance rate **with its raw counts**, services, training, commissions and tickets
6. **Availability roster** — every approved Pro in a city with their `isAvailable` flag, filterable, with bulk on/off. This is a daily-use screen: since Pros cannot set the flag themselves, ops switches the workforce on each morning and off each evening
7. **Bulk operations** — a dedicated surface for mass edits, so ops is never forced into one-by-one changes; runs async with a downloadable error log

*Reporting*
8. Async report exports in CSV, XLSX or PDF
9. Filterable by Pro, city, service, customer segment and date range
10. Report types: commission, operational, retention, city performance
11. Bookings, revenue and retention analytics structured for marketing decisions

*Finance*
12. Commission rate configuration **per service** — `commissionType` and `commissionValue` on the catalogue row. There are no tiers
13. Payout batch review and approval
14. Collections, dues and variance views over the ledger

*Governance*
15. Audit log of every mutating admin action, with before and after state and IP — **including every availability toggle**, so "why did Ravi get no jobs on Tuesday" is answerable
16. Platform settings management

**Depends on:** every other module (read), Ledger, Commission, Dispatch

---

## Cancellation & Refund Flow

Cancellation touches six modules and is the flow most likely to be built wrong, because the correct behaviour depends entirely on **when** it happens. The scope document does not define a cancellation policy, so the windows below are a proposal — the timings and fee are business decisions, but the mechanics are not.

### Four principles

1. **Nothing is ever deleted or edited.** A cancellation appends a status event; a refund appends a ledger entry. The original charge entry stays exactly as written.
2. **A Pro cannot cancel.** They are salaried employees who cannot decline work. If a Pro genuinely cannot proceed — illness, accident, vehicle failure — ops closes that assignment as `ops_reassigned` and dispatch re-runs. It only becomes a cancellation when reassignment is exhausted.
3. **Salary decouples cancellation from Pro pay.** A Pro who travels to a job the customer then cancels is still on salary. No travel compensation is owed, and no commission arises because no job completed. This is a direct consequence of the employment model and removes what is normally the hardest part of this flow.
4. **Refunds are asynchronous.** Razorpay initiates instantly but settles to the customer's instrument in roughly 5–7 working days. "Refund initiated" and "refund settled" are different states and the customer must be told which they are in.

### The six windows

| Window | Booking status | Customer refund | Assignment | Commission |
|---|---|---|---|---|
| **A** — before payment | `created`, `awaiting_payment` | nothing was charged | none exists | none |
| **B** — paid, not yet assigned | `assigning` | 100% | none exists | none |
| **C** — assigned, not yet travelling | `assigned` | 100% | closed, Pro freed for other work | none |
| **D** — Pro en route or arrived | `en_route`, `arrived` | 100% less cancellation fee *(configurable, default 0)* | closed; Pro is salaried, nothing owed | none |
| **E** — job under way | `started` | partial, at ops discretion | job stopped | only if ops directs, computed on actual duration |
| **F** — job completed | `completed` | **not a cancellation** — see disputes below | — | reversed if the refund is upheld |

Windows A–D reverse no commission because `BookingCommission` is only written on completion. There is nothing to unwind.

### Who cancels, and why

| Actor | Trigger | Recorded as |
|---|---|---|
| **Customer** | in-app, any time before `started`; after that, only through support | `cancelledByType = customer` |
| **Ops** | safety incident, fraud, duplicate booking, or dispatch exhausted with no Pro found | `cancelledByType = ops` |
| **System** | payment never completed inside the hold window; recurring plan ended; max assignment attempts exhausted | `cancelledByType = system` |
| **Pro** | **never** — see principle 2 | *(no such path)* |

### Refund execution

1. Ops or the system triggers a refund against the booking
2. Payments module calls Razorpay refund — full or partial — against the captured `Payment`
3. `razorpay_refund_id` captured immediately; refund state set to **initiated**
4. `LedgerEntry(refund)` written at initiation — the liability is recognised the moment it is promised, not when it clears
5. `Booking.paymentStatus = refunded`
6. Customer notified with the expected settlement window
7. Razorpay `refund.processed` webhook confirms settlement; refund state → **settled**
8. Nightly reconciliation checks every initiated refund has settled, and flags any that has not

Partial refunds are recorded against the specific `Payment` that was captured, so a booking paid across a failed-then-successful attempt sequence refunds cleanly against the right one.

### Commission reversal

Only reachable from windows E and F.

- `BookingCommission.status = reversed`, plus a **reversing `LedgerEntry`** — the original commission entry is never touched
- **If the commission was already paid out**, the reversal becomes a **deduction on the Pro's next `CommissionPayout`**. Money is never clawed back from a Pro's bank account
- `ProIncentiveProgress` decrements — a reversed job must not count toward a jobs-count incentive
- `Pro.completedJobs` decrements, and the nightly counter rebuild corrects it regardless

### Post-completion disputes

A completed job cannot be cancelled. It is disputed, which is a different path with a different evidence bar.

1. Customer raises a `SupportTicket` with `category = dispute`
2. Ops reviews the evidence the system already holds:
   - `BookingStatusEvent` timeline — arrival, OTP-verified start, completion, each with coordinates
   - `JobPhotoProof` — the Pro's mandatory geo-stamped completion photos
   - `Booking.routeTrail` — where the Pro actually went
   - `ChatMessage` — what was said during the job
   - `Review.photoUrls` — the customer's own photos, if supplied
3. Ops upholds or rejects, recording `resolutionNotes`
4. If upheld: refund flow above, plus commission reversal
5. The ticket's `actionTaken` records any consequence for the Pro — warning, retraining, per-service suspension, or full suspension

This is what the OTP-verified start and mandatory photo proof are *for*. Without them a dispute is the customer's word against the platform's.

### Module responsibilities

| Module | Role in this flow |
|---|---|
| **4 · Booking** | Owns the state transition, cancellation reason and actor; writes the status event |
| **5 · Dispatch** | Closes any live assignment, releases the Pro, cancels queued retries |
| **7 · Payments** | Executes the Razorpay refund, tracks initiated → settled |
| **8 · Commission** | Reverses commission, schedules the deduction if already paid out |
| **9 · Ledger** | Appends refund and reversal entries; nightly recon verifies settlement |
| **11 · Safety & Support** | Owns dispute tickets and the evidence review |
| **12 · Notifications** | Tells the customer what was refunded and when it will land |

### Where the refund fields live

All three fields this flow needed are now in the model.

| Field | Location | Purpose |
|---|---|---|
| `cancelledAt` | `Booking` | `cancelReason` and `cancelledByType` needed a timestamp alongside every other authoritative Booking time |
| `cancellationFeeAmount`, `refundedAmount` | `Booking` | Windows D and E allow a partial refund — this is the record of what was retained |
| `refundStatus`, `razorpayRefundId`, `refundAmount`, `refundedAt` | `Order` | Moved here when `Payment` was dropped. `refundStatus` carries `none → initiated → settled \| failed`, the five-to-seven-day state customers keep asking about |

The nightly reconciliation flags any refund still `initiated` past the expected settlement window as an `unsettled_refund` discrepancy.

---

## Cross-cutting concerns

| Concern | Approach |
|---|---|
| **Idempotency** | Payment webhooks, notification sends and dispatch assignment are all idempotent — retries are safe |
| **Concurrency** | Booking assignment guarded by a Redis distributed lock plus a database partial-unique constraint |
| **Audit** | Two trails: `BookingStatusEvent` for job lifecycle, `AdminAuditLog` for admin mutations |
| **Money integrity** | Append-only hash-chained ledger, verified nightly against source records |
| **Derived data** | Counters incremented on write, rebuilt nightly from source; source always wins on conflict |
| **PII** | Aadhaar and PAN numbers masked at rest; phone numbers masked in customer↔Pro calling |
| **Config** | No magic numbers — every tunable lives in PlatformSetting |

---

## Suggested build order

| Phase | Modules | Rationale |
|---|---|---|
| 1 | Identity, Customer Profile, Catalog, Config | Nothing else works without accounts, addresses and something to book |
| 2 | Pro Management, Geo & Routing, Notifications | Supply side and the shared services dispatch needs |
| 3 | Booking, Dispatch | The core loop — this is where the product becomes real |
| 4 | Payments, Commission | Money in, money out |
| 5 | Ledger & Reconciliation, Admin Console | Books and the operations surface |
| 6 | Training & Quality, Safety & Support | Trust layer — required for launch, not for a working demo |

Phase 3 is the risk concentration. Dispatch depends on Pro rosters, geo routing and booking state simultaneously, and it is the module where a wrong decision is most expensive to unwind.
