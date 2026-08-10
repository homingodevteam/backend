# Admin — User Stories

Everything the internal team can do. **Conventions:** [README](README.md) · **Module view:** [`../user-stories/`](../user-stories/README.md)

---

## "Admin" is four jobs, not one

The schema has a single `AdminUser` table and a `Role` table. That is deliberate — but the console it drives serves four very different people, and grouping their stories by sub-role is the only way the console makes sense.

| Sub-role        | Cares about           | Typical day                                                                                                 |
| --------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Ops**         | Supply and dispatch   | Switching the workforce on for the day, watching unassigned bookings, approving Pros, editing the catalogue |
| **Support**     | One customer, one job | Tickets, disputes, SOS, billing queries                                                                     |
| **Finance**     | Money integrity       | Payout approval, reconciliation, refunds                                                                    |
| **Super-admin** | The other three       | Roles, permissions, audit trail                                                                             |

`Role` and `AdminUser.cityIds` are what separate them. A support agent must not be able to approve a payout batch; a Mumbai ops lead must not be able to suspend a Bengaluru Pro.

## What admins control that nobody else does

Pricing, commission rates, the catalogue, who is a Pro and which services they hold, **whether each Pro is on duty**, every platform tuning constant, the home screen, and the final word on any dispute.

**All three dispatchability gates are admin-set** — `status`, `ProService.isActive` and `isAvailable`. A Pro cannot make themselves available for work by any means.

## What admins cannot do

**Edit the ledger.** `LedgerEntry` is append-only and hash-chained. A wrong entry is corrected by writing a reversing entry, never by an UPDATE.

**Change what a Pro was already paid.** Commission rates are snapshotted at computation.

**Administrative audit trail is deferred.** Its schema, retention policy and review workflow are not part of the current development scope and must be decided before implementation.

---

# 1 · All admins

### US-1.9 · Log in `A`

- **State:** Same phone + OTP as everyone else, against `AdminUser`.
- **Edge:** **Admin accounts are created by other admins, never self-registered.** An open sign-up path to the console is the single worst hole this system could have.

### US-1.10 · Be stopped at an action outside my permissions `A`

- **State:** Permission checked against `Role.permissions` on every request.
- **Edge:** Enforced **server-side**. Hiding the button is presentation, not security.

### US-1.11 · Be scoped to my cities `A`

**As** a regional ops lead **I want** to see only my cities **so that** I don't act on someone else's supply.

- **State:** `AdminUser.cityIds` filters every list and blocks every write outside it.
- **Edge:** The filter must apply to **exports and bulk operations too** — that is where scoping is most often forgotten and most damaging.

### US-1.12 · Have a role change take effect immediately `A`

- **State:** Permissions resolved per request, not cached in the session.
- **Edge:** Someone stripped of permissions mid-shift must lose them on the next click, not at next login. This is what makes revocation real.

### US-15.11 · Have every action of mine audited `A` `S` — DEFERRED

- **State:** Product and retention requirements are not decided; no audit-log model or write flow is currently implemented.
- **Future decision:** Actor, entity, before/after state, timestamp, IP, retention and access policy must be specified together.

### US-15.12 · Review the audit trail `A` — DEFERRED

- **State:** No review endpoint or persistence exists until US-15.11 is decided.

### US-15.13 · Change a role's permissions `A`

- **State:** `Role.permissions` updated server-side.
- **Ripple:** Every admin holding that role is affected at once.
- **Edge:** Editing a role is far more dangerous than editing one user. Removing a permission from a widely-held role can lock out the whole team.

### US-15.14 · Deactivate an admin `A`

- **State:** `AdminUser.isActive = false`.
- **Ripple:** Sessions invalidated; **their audit history is preserved**.
- **Edge:** Deactivate, never delete. Deleting the actor breaks the trail their actions belong to.

---

# 2 · Ops — dispatch

### US-15.1 · Watch live dispatch `A`

**As** ops **I want** one board of every in-flight booking **so that** I catch problems before customers do.

- **State:** Read of `Booking` assignment fields plus Redis live positions.
- **Edge:** Highest-value screen in the console. The queue that matters is **unassigned and waiting** — sorted by how long, not by when created.

### US-15.3 · See why a booking is unassigned `A`

- **State:** Read of `AssignmentCandidate` rows for the attempt, with each candidate's scores and exclusion reason.
- **Edge:** This is the whole point of persisting candidates. Without them the engine is a black box and ops escalates to engineering for every question.

### US-5.11 · Answer "why wasn't this Pro chosen?" `A`

- **State:** Same candidate rows — rank, travel time, rotation score and `ratingScore`, or the reason they were filtered out.
- **Edge:** A Pro who was **never a candidate** (unavailable, no service, rotation cooldown) must be distinguishable from one who was ranked and lost. They are different conversations.
- **Edge:** `ratingScore` is the **smoothed** value, not the Pro's displayed rating. A Pro showing 5.0 from two reviews can legitimately lose to one showing 4.6 from two hundred. The screen should show both numbers, or ops will read it as a bug.

### US-5.10 · Handle a booking that exhausted every candidate `S` `A`

- **State:** `assignmentOutcome = exhausted`; ops alerted.
- **Ripple:** The customer is still waiting, with no Pro and no error.
- **Edge:** **The alert must fire before the slot time, not at it.** By the slot time it is already a failure.

### US-5.5 · Handle "no Pro holds this service here" `S` `A`

- **State:** Empty pool at Rule 1; flagged as a supply gap rather than a dispatch failure.
- **Edge:** A structural supply problem dressed as a per-booking error will be triaged as a bug for months. Separate the two.

### US-5.12 · Override an assignment `A` `P`

- **State:** `Booking.proId` replaced; `overriddenByAdminId` and `overrideReason` set; audited.
- **Ripple:** Old Pro loses the job; new Pro is pushed. Customer sees a new name.
- **Edge:** **A reason is mandatory.** Overrides are the main way the engine's rules get quietly bypassed; unexplained ones make the acceptance-rate data meaningless.

### US-6.12 / US-6.13 · Switch Pros on and off duty `A` `P` `S`

**As** ops **I want** to control who is available **so that** supply matches the day.

- **State:** `Pro.isAvailable` with `availabilityUpdatedAt`; every change audited.
- **Ripple:** Immediate entry to or exit from candidate pools. **Committed bookings are never affected.**
- **Edge:** **This is a daily-use screen, not a settings page.** Pros cannot set the flag themselves, so ops switches the workforce on each morning. Without a per-city roster view with bulk on/off, it is a per-record chore that will get skipped — and a Pro nobody switches on loses a day's work with no error anywhere in the system.
- **Edge:** Ops needs an inbound channel for "I'm unwell, take me off". A toggle nobody can ask you to press doesn't help the Pro who wakes up ill at 6am.
- **Open:** Should the flag auto-clear at end of day? Left on overnight, a Pro is dispatched work at 6am and times out on it.

### US-5.13 · Handle a Pro going dark after acknowledging `P` `A` `S`

- **State:** No GPS and no status change past a threshold → ops alerted.
- **Edge:** Ambiguous — dead battery, no signal, or a real problem. Ops calls before the system reassigns.

### US-4.22 · Cancel for lack of supply `A` `C` `S`

- **State:** `status = cancelled`, cancelled by admin. **Full refund, no fee.**
- **Ripple:** Customer notified with a reason.
- **Edge:** **Never charge a cancellation fee when the platform is the one that failed.**

---

# 3 · Ops — Pro onboarding

### US-6.4 · Make the verification call `A`

**As** an onboarding admin **I want** to check documents myself **so that** we know who we're sending into homes.

- **State:** Per-document status, reason and verifier recorded on `ProApplication`.
- **Edge:** Manual by design. No automated KYC provider is in scope.

### US-6.3 · Approve one document and reject the other `A` `P`

- **State:** `aadhaarStatus` and `panStatus` move independently.
- **Ripple:** The applicant is told exactly which file to replace.

### US-6.5 · Approve the Pro `A` `P` `S`

- **State:** `status = approved`, `approvedApplicationId` pinned to this attempt.
- **Edge:** **Approval alone does not make them dispatchable.** Services and availability are the other two gates — surface all three in the UI or ops will wonder why an approved Pro gets nothing.

### US-6.6 · Reject an applicant `A` `P`

- **State:** `ProApplication.status = rejected` with a reason. The `Pro` row stays.
- **Edge:** Keeping the row is what makes reapplication and its history possible.

### US-6.8 · Assign services `A` `P` `S`

- **State:** `ProService` rows.
- **Ripple:** Second of the three gates. The Pro is dispatchable once `isAvailable` is also set.
- **Edge:** Warn when the service has mandatory training the Pro hasn't completed.

### US-6.9 · Suspend from one service `A` `P`

- **State:** `ProService.isActive = false`.
- **Edge:** With quality audits gone, this is the main proportionate response to a complaint. The reason lives on the originating `SupportTicket`.

### US-6.10 · Suspend a Pro entirely `A` `P` `C`

- **State:** `Pro.status = suspended`.
- **Ripple:** No future dispatch. **Live bookings must be handled explicitly.**
- **Edge:** Earnings already accrued stay payable.

### US-5.15 · Suspend a Pro between assignment and start `A` `P` `C`

- **Edge:** If the Pro has already arrived, a phone call beats a remote cancellation. The system should surface the conflict, not resolve it silently.

### US-6.11 · Reinstate `A` `P`

- **Edge:** Check all three gates. Status alone leaves them approved and idle.

### US-10.4 / US-10.5 · Schedule offline training and mark attendance `A` `P`

- **State:** `OfflineTrainingSession` and `OfflineTrainingAttendance`.
- **Edge:** Attendance is marked by an admin, not self-reported. That is the only reason the record is worth anything.

### US-10.6 · Mandate retraining after a complaint `A` `P`

- **State:** `ProTrainingProgress` reset; `SupportTicket.actionTaken = retraining`.
- **Edge:** The ticket is the only record of _why_.

---

# 4 · Ops — catalogue and cities

### US-3.4 · Create a service `A`

- **State:** `Service` with price, duration, category, commission type and value.
- **Edge:** **One flat national price.** No city pricing exists in the model.

### US-3.5 · Change a service price `A`

- **State:** `Service.price` updated; audited.
- **Ripple:** Existing bookings are unaffected — price is snapshotted onto `Booking` at creation.
- **Edge:** **Commission does not follow price.** A percentage rate scales; a flat rate does not. See US-3.11.

### US-3.10 · Set a commission rate `A` `P`

- **State:** `Service.commissionType` (`percent` | `flat`) and `commissionValue`.
- **Ripple:** Applies to **future** completions only. Past `BookingCommission` rows hold snapshotted rates.
- **Edge:** Same story as US-8.1 — commission configuration lives on the catalogue row now that `CommissionTier` is gone.

### US-3.11 · Activate a service with no commission rate `A` `S`

- **State:** Should be **blocked**.
- **Ripple:** Otherwise jobs complete and produce no commission, and the Pro is unpaid for real work.
- **Edge:** Failing silently at completion time is the worst possible place to discover a missing config value.

### US-8.4 · Reprice without touching commission `A` `P`

- **Edge:** With `commissionType = flat`, a price cut cuts the platform's margin, not the Pro's pay. With `percent`, it cuts both. Ops must see which mode a service is in **on the repricing screen**.

### US-3.6 · Change a service duration `A`

- **Edge:** Duration drives slot sizing and ETA. Changing it does not resize bookings already placed.

### US-3.7 · Deactivate a service with live bookings `A`

- **State:** `isActive = false` stops new bookings; committed ones continue.
- **Edge:** Deactivating must never cancel work already sold.

### US-3.8 · Restructure the category tree `A` `C`

- **Ripple:** Changes what every customer sees on the home screen.
- **Edge:** Services must not be orphaned by a category deletion.

### US-3.9 · Activate a new city `A`

- **State:** `City.isActive = true`.
- **Ripple:** The area becomes bookable.
- **Edge:** **Activating a city with no approved Pros in it produces bookings nobody can serve.** Gate on supply.

---

# 5 · Ops — configuration and app content

### US-14.1 · Change the no-start grace window `A` `S`

- **State:** `PlatformSetting`.
- **Ripple:** Directly controls how many internal no-start tickets ops receives.
- **Edge:** Too short floods the queue; too long lets real problems sit.

### US-14.2 · Tune the acknowledgement window `A` `P` `S`

- **Ripple:** Shortening it raises no-ack timeouts and reassignments. Customers wait longer through more dispatch cycles; Pros lose individual jobs.
- **Edge:** It does **not** cascade into Pro ranking, because acceptance rate is analytics only. Watch the reassignment rate and time-to-assignment after any change.

### US-5.17 · Tune how newer Pros rank `A` `S` `P`

**As** ops **I want** control over how much a thin review history counts **so that** new hires get work without displacing proven ones.

- **State:** `PlatformSetting dispatch.ratingPriorMean` and `dispatch.ratingPriorWeight`, feeding the smoothed score `(ratingSum + priorMean × priorWeight) / (ratingCount + priorWeight)`.
- **Ripple:** **Redistributes work across the entire city.** Raising `priorMean` favours unproven Pros; raising `priorWeight` keeps everyone near the average for longer.
- **Edge:** **Treat this like a pricing change.** It has no immediate visible effect and a large delayed one — a bad value shows up weeks later as new Pros starving or bad hires being kept busy.
- **Edge:** Set `priorMean` from the actual platform average once there is data. Guessing high hands work to unproven Pros; guessing low recreates the cold-start problem it exists to solve.

### US-14.3 · Set a city-specific value `A`

- **State:** City-scoped `PlatformSetting` overriding the global.
- **Edge:** Resolution order must be exactly one rule — city, then global — and be visible in the UI.

### US-14.4 · Change the rotation cooldown `A` `S`

- **Ripple:** Longer means more variety for customers, more travel for Pros, and a smaller candidate pool.
- **Edge:** Set too long in a thin city and dispatch starts exhausting candidates.

### US-14.5 · Have setting changes audited `A` `S`

- **Edge:** Settings changes are the least visible and most consequential edits in the console. Before-and-after values are mandatory.

### US-14.6 · Publish a new home screen `A` `C`

- **State:** New `UiConfig` version; CDN invalidated.
- **Ripple:** Live customers see it without an app update.
- **Edge:** A broken config breaks the app for everyone at once. Preview before publish.

### US-14.7 · Target a config by city or segment `A` `C`

- **Edge:** Overlapping targets need a deterministic precedence rule, or two customers in the same city see different screens for no reason anyone can explain.

### US-14.8 · Roll back a bad publish `A` `C`

- **State:** Previous version reactivated.
- **Edge:** **Rollback must be one click.** During a bad publish there is no time to build a fix.

---

# 6 · Ops — bulk work and reporting

### US-15.6 · Run a bulk update `A`

- **State:** `AdminJob` with progress; each affected row audited individually.
- **Edge:** **One audit entry per affected row**, not one for the batch. Otherwise a 500-row change is a single unreviewable line.

### US-15.7 · Handle a partially failed bulk update `A` `S`

- **State:** Per-row outcomes recorded; failures downloadable.
- **Edge:** **Do not roll back the successes.** Report what worked, what didn't, and why — a partial failure with a clear report is recoverable; an all-or-nothing rollback of 480 good rows is not.

### US-15.8 · Export a report `A`

- **Edge:** Exports must respect `cityIds` scoping and must mask Aadhaar and PAN. An export is the easiest way to leak data the console itself protects.

### US-15.9 · Export something too large to generate live `A` `S`

- **State:** `AdminJob`, async, downloadable when ready.
- **Edge:** Download links should expire.

---

# 7 · Support

### US-15.4 · Open a customer 360 view `A`

- **State:** One read across bookings, orders, refunds, reviews, tickets, addresses and notifications.
- **Edge:** **Support's primary screen.** Without it an agent runs six searches while the customer waits.

### US-15.5 · Open a Pro 360 view `A`

- **State:** Application, documents, services, training, ratings, acceptance rate, availability, commissions, payouts, tickets.
- **Edge:** Documents must be masked here too. A support agent needs to see that a PAN was verified, not what it is.
- **Edge:** Show acceptance rate **with its raw counts** and label it as reporting. It affects nothing automatically, so an agent reading it as a penalty score will draw the wrong conclusion — 3 of 4 missed is not the same story as 30 of 400.

### US-12.9 · Check what a customer was actually told `A`

- **State:** Read of `NotificationLog`.
- **Edge:** Settles "nobody told me" instantly. This is the main reason the log exists.

### US-4.24 · Reconstruct a disputed job `A`

- **State:** `BookingStatusEvent` timeline, `JobPhotoProof`, `ChatMessage`, `routeTrail`, notification log.
- **Edge:** Every piece must be readable from one screen. If reconstruction takes four tabs, disputes get settled on the customer's word instead of the record.

### US-7.5 · Handle repeated payment failures `C` `A`

- **Edge:** The customer sees only "failed". The `failureCode` on `Order` is what lets support say something useful.
- **Edge:** **Attempt-level questions leave the console.** Retries, duplicate charges and which instrument was used are looked up by an admin in the Razorpay dashboard. Nothing is built here for it — a deliberate call, not a gap.

### US-11.5 · Handle a billing query `C` `A`

- **State:** `SupportTicket`, `category = billing`.

### US-11.3 · Acknowledge and resolve an SOS `A`

- **State:** `SosAlert` → acknowledged → resolved, with responder and outcome.
- **Edge:** **Acknowledgement must be a hard SLA with escalation on breach.** An unacknowledged SOS is the most serious failure state in the platform.

### US-12.8 · Be alerted to an SOS `A` `S`

- **Edge:** Must not depend on someone watching a dashboard. Push, SMS and a phone call chain.

### US-11.4 · Close a false alarm `C` `P` `A`

- **Edge:** Zero penalty, on either side. Deterring the button is worse than any number of false alarms.

### US-11.7 · Receive an internal no-start ticket `S` `A` `P`

- **State:** `isInternal = true`, `raisedByType = system`.
- **Edge:** **Never visible to the Pro.** Most are benign — nobody home, wrong address. Ops must have a fast benign-close path or the queue becomes noise and the real ones get missed.

### US-11.8 · Add an internal note `A`

- **Edge:** Enforced server-side. Leaking an internal note into a customer thread is a live risk on every ticket screen.

### US-11.9 · Escalate a ticket `A`

- **State:** Priority raised, reassigned; history preserved.

### US-11.10 – US-11.13 · Handle a dispute end to end `C` `A` `P`

- **State:** Ticket → evidence review → upheld or rejected, with `actionTaken`.
- **Ripple (upheld):** Refund to the customer, **commission reversal against the Pro**, possibly retraining.
- **Edge:** The Pro is affected but is not party to the decision. `actionTaken` is the only record connecting a reversal to its reason — leave it blank and finance sees an unexplained deduction.

### US-11.14 · Spot repeat disputes against one Pro `A` `S`

- **State:** Dispute count per Pro, surfaced in the Pro 360 view.
- **Edge:** **With `ProQualityAudit` gone, this and the rating counters are the only quality signals left.** One dispute is noise; five against the same Pro is a pattern, and nothing else in the system will surface it.

### US-10.9 · Hide an abusive review `A` `C` `P`

- **State:** `Review.isHidden = true` with a reason.
- **Edge:** Rating is now the **only** Pro attribute driving work allocation, which raises the stakes here. Hiding a review that still counts toward `ratingSum` protects the Pro's profile and not their livelihood.
- **Open:** Does a hidden review still count toward the rating? Undecided.

### US-10.10 · Hide a photo exposing a customer's home `A` `C`

- **Edge:** Hide the photo without discarding the review text.

### US-4.15 · Handle "customer wasn't home" `C` `P` `A`

- **Edge:** Whether the customer is charged is a policy call. The system records the arrival and the failed start; ops decides.

### US-4.21 · Handle a mid-job cancellation `C` `A`

- **Edge:** Work was partly done. Refund is discretionary, not formulaic — route it to a human.

---

# 8 · Finance

### US-8.1 / US-8.2 · Set commission as a percentage or a flat amount `A`

- **State:** `Service.commissionType` and `commissionValue`.
- **Edge:** Flat is predictable for the Pro; percent tracks price changes. The mode must be visible everywhere the price is edited.

### US-8.3 · Change a rate after jobs have completed `A`

- **Edge:** **Past commissions are immutable** — snapshotted at computation. This must be stated in the UI, or someone will edit a rate expecting a retroactive correction.

### US-8.8 · Discover a service with no commission rate `S` `A`

- **Edge:** Should be impossible if US-3.11 is enforced. If it happens, alert immediately — every completion on that service is silently unpaid work.

### US-8.10 / US-15.10 · Approve a payout batch `A` `P`

- **State:** `CommissionPayout` approved, then disbursed via RazorpayX.
- **Edge:** **Approval and execution must be separate permissions**, and ideally separate people. This is the largest outbound money movement in the system.

### US-8.11 · Handle a failed payout `S` `A` `P`

- **Edge:** Underlying commissions stay unpaid until disbursement confirms. Marking them paid on submission is how a Pro ends up recorded as paid with nothing in their account.

### US-8.13 / US-8.14 · Reverse a commission `A` `P`

- **State:** Reversal entry; if already paid, an itemised **deduction on the next payout**.
- **Edge:** **Never debit a Pro's bank account.**

### US-7.10 / US-7.12 · Initiate a full or partial refund `A` `C`

- **State:** Razorpay refund; `Order.refundAmount`, `razorpayRefundId`, `refundStatus`; `Booking.refundedAmount`.
- **Edge:** **Cumulative, not per-refund.** A booking can be refunded more than once, and the sum can never exceed what was captured.

### US-7.11 · Explain why a refund hasn't landed `S` `C`

- **Edge:** Bank settlement takes days. Show the initiation date and expected window, or support fields the same call three times.

### US-7.13 · Handle a refund that fails at the gateway `S` `A`

- **Edge:** Must alert. A silently failed refund is a customer who was promised money and never got it.

### US-7.9 · Handle a payment captured for an already-cancelled booking `S` `A`

- **Edge:** Auto-refund and alert. This is a race, not a fraud, and it must not need a human to notice it.

### US-9.3 · Correct a wrong ledger entry `A`

- **State:** **A reversing entry.** The original is never touched.
- **Edge:** The hash chain is the point. An UPDATE breaks it and destroys the guarantee for every entry after.

### US-9.4 / US-9.5 · Run nightly reconciliation `S` `A`

- **State:** `ReconciliationRun`; variances written as `ReconciliationDiscrepancy`.
- **Edge:** **A clean run must be recorded too.** "No discrepancies" and "the job didn't run" look identical otherwise.

### US-9.6 · Resolve a discrepancy `A`

- **State:** Resolution and note recorded.
- **Edge:** Resolving without a note leaves the next person with a closed variance and no explanation.

### US-9.7 · Chase a refund that never settled `S` `A`

- **Edge:** Surfaces as a reconciliation variance days later. This is what catches the refunds nobody was watching.

### US-9.9 · View daily collections `A`

- **State:** Ledger aggregation.
- **Edge:** Read from the ledger, not from `Order`. The ledger is the accounting record.

### US-9.10 · Trace one booking's money `A`

- **State:** All `LedgerEntry` rows for the booking — capture, commission, refund, reversal.
- **Edge:** The single most useful finance screen. It answers "where did this ₹499 go" without a spreadsheet.

### US-9.8 · Let derived counters self-heal `S`

- **State:** `ratingSum`, `ratingCount`, `assignmentsOffered`, `assignmentsAcknowledged`, `completedJobs` rebuilt periodically; `countersRebuiltAt` stamped.
- **Edge:** **`ratingSum` and `ratingCount` drive dispatch ranking** — drift there silently changes who gets work, making the rebuild a correctness job rather than housekeeping. The assignment counters only affect reports, so drift there is cosmetic. Worth alerting differently.

---

# 9 · When systems degrade

Admins are the last line when a dependency fails. All of these need to be visible in the console.

| Failure                         | Behaviour                                                                            | Story                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **Redis down**                  | Fall back to `Pro.lastKnownLat/Lng` and Postgres availability. Slower, still assigns | [US-13.6](../user-stories/13-geo-and-routing.md)       |
| **OpenStreetMap down**          | Haversine instead of routed time. Rankings degrade                                   | [US-13.7](../user-stories/13-geo-and-routing.md)       |
| **OTP provider down**           | Nobody can log in and no job can start. **No fallback exists**                       | [US-1.5](../user-stories/01-identity-and-access.md)    |
| **Push provider down**          | SMS fallback. Bookings burn dispatch cycles; Pro rankings are unaffected             | [US-12.3](../user-stories/12-notifications.md)         |
| **Razorpay webhooks delayed**   | Client callback and webhook must both be idempotent                                  | [US-7.7](../user-stories/07-payments.md)               |
| **No candidates anywhere**      | Supply gap, not a bug — alert before the slot time                                   | [US-5.5](../user-stories/05-dispatch-engine.md)        |
| **Service with no commission**  | Silent unpaid work. Must be blocked at activation                                    | [US-8.8](../user-stories/08-commission-and-payouts.md) |
| **CDN serving a bad UI config** | One-click rollback                                                                   | [US-14.8](../user-stories/14-config-and-sdui.md)       |

**Every degradation must be visible.** Silently worse dispatch gets diagnosed as an algorithm bug and debugged in the wrong place for a week.

---

## Settled decisions

| Question                                           | Decision                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Who sets `Pro.isAvailable`?**                    | **Admins only.** Pros are salaried; ops plans supply centrally. Needs a per-city roster screen with bulk on/off, or it becomes an unmanageable daily chore ([US-6.14](../user-stories/06-pro-management.md)) |
| **Does `acceptanceRate` affect ranking or pay?**   | **No — analytics only.** It exists so ops can spot a Pro who repeatedly misses assignments, not so the system can demote them for a failed push ([US-6.17](../user-stories/06-pro-management.md))            |
| **How does a new Pro rank with no reviews?**       | **At the platform average**, via a smoothed score with two `PlatformSetting` constants. No grace flag, no expiry, no schema change ([US-5.17](../user-stories/05-dispatch-engine.md))                        |
| **How does support answer "was I charged twice?"** | **In the Razorpay dashboard.** No console feature is planned; the story was dropped                                                                                                                          |

## Open questions for the admin console

| Question                                                       | Why it matters                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Does `isAvailable` auto-clear at end of day?**               | Admin-set with no expiry, a Pro left switched on overnight is dispatched work at 6am and times out on it                                      |
| **What's the inbound channel for "I'm unwell"?**               | The Pro cannot switch themselves off. Without a fast route to ops, jobs get assigned to people who aren't working                             |
| **Does a hidden review still count toward rating?**            | Rating is now the only signal driving work allocation, so this decides whether moderation protects the Pro's livelihood or just their profile |
| **What are the SOS acknowledgement SLA and escalation chain?** | Undefined, and it is the most serious alert in the system                                                                                     |
| **Are cancellation-fee waivers a permission?**                 | Support will be asked constantly. Without a rule it becomes per-agent discretion                                                              |
| **What replaces proactive quality checks?**                    | `ProQualityAudit` is gone. Only reviews and repeat-dispute counts remain, and both are reactive                                               |
