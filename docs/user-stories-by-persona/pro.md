# Pro — User Stories

Everything the salaried service professional can do, and everything the system does to them.
**Conventions:** [README](README.md) · **Module view:** [`../user-stories/`](../user-stories/README.md)

---

## What a Pro controls

Their application and documents, their bank details, whether they acknowledge a job in time, how they do the work, and the photo proof they submit.

## What a Pro does not control

**Which jobs they get.** The system assigns. There is no accept and no decline — only *acknowledge*. A job they don't acknowledge in time goes to someone else.

**Whether they're on duty.** `Pro.isAvailable` is set by an admin. A Pro who is unwell has to reach ops; they cannot switch themselves off.

**Which services they're allowed to do.** Ops grants and suspends `ProService` rows.

**Their pay rate.** Commission is set per service on the catalogue row. Salary is recorded but paid outside this system entirely.

## What decides how much work a Pro gets

**Customer rating, and nothing else about them.** Applied as a smoothed score, so a Pro with three reviews is neither punished for having few nor over-trusted for having good ones.

**Acceptance rate does not affect it.** That figure is tracked and shown, but it changes no ranking and no pay — deliberately, so an undelivered push never costs a Pro work they'd have done.

## What a Pro never sees

The no-start ticket raised when they arrive but don't begin — deliberately internal. Internal notes on any ticket about them. The customer's address before assignment. Other candidates' scores from the dispatch run they won or lost.

---

# 1 · Applying to join

### US-6.1 · Apply from my phone `P`
**As** someone referred by a friend **I want** to apply in the app **so that** I don't have to visit an office.
- **State:** `Pro` created with `status = applied`; `ProApplication` with referral attribution.
- **Ripple:** Appears in the admin onboarding queue. **Invisible to dispatch.**
- **Edge:** Applying twice while the first is pending should update the existing application, not create a second queue entry two admins review independently.

### US-6.2 · Upload my Aadhaar and PAN `P`
**As an** applicant **I want** to upload my documents **so that** I can be verified.
- **State:** Files to S3; URLs and masked numbers on `ProApplication`; both statuses pending.
- **Ripple:** Queue status advances to `docs_review`.
- **Edge:** Numbers are masked at rest — the full value must never appear in logs, exports or admin list views.

### US-6.3 · Be told exactly which document failed `A` `P`
**As an** applicant **I want** to know it was the PAN, not the Aadhaar **so that** I re-upload the right one.
- **State:** `aadhaarStatus = verified`, `panStatus = rejected` with its own reason and verifier.
- **Edge:** This is why per-document status exists. A single `docsVerified` flag would leave me guessing which file to replace.

### US-6.7 · Apply again after rejection `P` `A`
**As a** rejected applicant **I want** a second chance with better documents **so that** one blurry photo doesn't end it.
- **State:** A **new** `ProApplication` against the same `Pro`. The earlier rejection, its reason and its documents are preserved.
- **Ripple:** The admin can see I was rejected before, and why.
- **Edge:** This is the whole reason application is a separate table from Pro.

### US-1.4 · Use the same number as my customer account `C` `P`
**As a** Pro who also books services at home **I want** one phone number **so that** I don't need two.
- **State:** `Customer.phone` and `Pro.phone` are unique within their own tables.
- **Edge:** Dispatch must never assign me to my own booking.

---

# 2 · Getting activated

### US-6.5 · Be approved `A` `P` `S`
**As an** approved applicant **I want** to start earning **so that** the wait was worth it.
- **State:** `Pro.status = approved`, `approvedAt` set, `approvedApplicationId` points at this attempt.
- **Ripple:** **Still not dispatchable.** Approval is one of three gates.
- **Edge:** Approved with no services assigned means I receive nothing and won't know why. The admin UI must show "not yet dispatchable" explicitly.

### US-6.8 · Be assigned the services I can do `A` `P` `S`
**As a** Pro **I want** my trades recorded **so that** I get the right jobs.
- **State:** `ProService` rows with proficiency.
- **Ripple:** I become a dispatch candidate for those services — **provided `isAvailable` is also true.**
- **Edge:** Assigning a service whose mandatory training I haven't completed should be blocked or warned.

### US-10.1 · Complete mandatory training `P` `A`
**As a** new Pro **I want** to work through required modules **so that** I can be activated.
- **State:** `ProTrainingProgress` per module, with percent complete and quiz score.
- **Ripple:** Activation for a service can be gated on completion.
- **Edge:** Modules are trade-level; my required set derives through `ProService → Service → categoryId`.

### US-6.15 · Add my bank details `P`
**As a** Pro **I want** to enter my account **so that** commission reaches me.
- **State:** `ProBankAccount`, masked, `isVerified` pending.
- **Ripple:** **Payouts are blocked until verified.**
- **Edge:** Changing bank details shortly before a payout run is a classic fraud pattern — expect re-verification and possibly a cooling-off period.

### US-6.20 · Log in on a new phone `P`
**As a** Pro who changed devices **I want** notifications on the new one **so that** I don't miss work.
- **State:** `Pro.pushToken` and `pushPlatform` **overwritten**.
- **Ripple:** **The old device stops receiving pushes immediately.**
- **Edge:** One token per Pro. Keep both phones logged in and only the last to register is reachable — I time out on assignments I never saw and lose those jobs. My ranking is unaffected, since acceptance rate carries no consequence. The app must re-register on every launch.

---

# 3 · Receiving work

### US-6.12 · Be put on duty by ops `A` `P` `S`
**As a** Pro starting my day **I want** to be marked available **so that** I start receiving jobs.
- **State:** An admin sets `Pro.isAvailable = true`; `availabilityUpdatedAt` stamped and the change audited.
- **Ripple:** I immediately enter candidate pools.
- **Edge:** **I cannot do this myself, and there is no roster — this flag alone decides whether I get work.** A morning nobody remembers to switch me on is a day of lost commission with no error message anywhere.

### US-6.13 · Be taken off duty by ops `A` `P` `S`
**As a** Pro finishing my day or falling ill **I want** to stop receiving jobs **so that** I'm not assigned work I can't do.
- **State:** An admin sets `Pro.isAvailable = false`; audited.
- **Ripple:** Excluded from future pools. **Committed bookings are unaffected** — going off duty does not abandon work I've taken.
- **Edge:** **I have to reach a human to make this happen.** If I wake up ill at 6am and ops isn't watching, jobs get assigned to me and time out. The inbound channel for this is as important as the toggle itself.
- **Edge:** Switching off with an unacknowledged assignment outstanding is ambiguous. Either block it, or treat it as a no-ack and reassign — and tell the admin which happened.

### US-12.2 · Receive a job push `P` `S`
**As a** Pro **I want** an immediate alert **so that** I can acknowledge within the window.
- **State:** Push to `Pro.pushToken`; delivery status tracked.
- **Ripple:** **The ack window is already running when the push is sent.**
- **Edge:** A miss costs me that one job and the customer some waiting. It moves my acceptance rate, but **that figure carries no consequence** — my ranking and pay are untouched. Keeping it out of ranking is exactly so a failed delivery doesn't compound against me.

### US-12.3 · Get an SMS when push fails `P` `S`
**As a** Pro **I want** a fallback **so that** I don't lose a job to a delivery problem.
- **State:** Delivery failure recorded; SMS sent for critical templates.
- **Edge:** The fallback must be fast enough to land inside the ack window. An SMS arriving after the timeout is a receipt, not a rescue.

### US-5.2 · Acknowledge a job `P`
**As a** Pro **I want** to confirm I've seen it **so that** ops knows it's in hand.
- **State:** `Booking.acknowledgedAt` set, `assignmentOutcome = acknowledged`. `assignmentsAcknowledged` incremented, `acceptanceRate` recomputed.
- **Ripple:** The booking settles on me. My acceptance rate rises — a number on my profile and on ops' dashboard, with no effect on my rank.
- **Edge:** **Acknowledgement is not acceptance.** There is no decline — I'm confirming receipt, not agreeing to take it.

### US-5.3 · Lose a job by not acknowledging `P` `S`
**As the** platform **I want** to move on when a Pro doesn't respond **so that** the customer isn't left waiting.
- **State:** `assignmentOutcome = no_ack_timeout`; I'm marked `already_tried`; the booking's assignment fields are overwritten with the next candidate.
- **Ripple:** My acceptance rate drops. **It costs me that job, not future ones** — the figure is reporting only.
- **Edge:** The window must exceed realistic phone-check latency, or good Pros who were simply driving lose jobs they'd have taken.
- **Edge:** A pattern of misses is something ops raises with me directly. The system doesn't quietly demote me for it, which means somebody has to actually look.

### US-5.7 · Be considered from where I'll actually be `S` `P`
**As a** Pro **I want** dispatch to route from my next job's location **so that** the ETAs I'm given are achievable.
- **State:** Origin = next scheduled job's location if one exists, else live GPS, else home base.
- **Ripple:** Finishing in Andheri at 2pm makes me a candidate *for jobs near Andheri* from 2pm — not near my home.
- **Edge:** **Inter-job travel is my own responsibility.** The origin choice must not promise the customer an ETA I can't meet.

---

# 4 · Doing the job

### US-4.9 · Mark en route `P`
- **State:** `status = en_route`; `BookingStatusEvent` with coordinates.
- **Edge:** I can go `en_route → arrived → en_route` if I leave and return. The event log holds all of it; `arrivedAt` holds the authoritative one.

### US-4.10 · Mark arrival `P`
- **State:** `Booking.arrivedAt` set; `BookingStatusEvent(arrived)` with coordinates.
- **Ripple:** Customer notified. **The grace-window clock starts.**
- **Edge:** The coordinates are captured wherever I actually am. Marking arrival from 3 km away is recorded as such.

### US-4.12 · Enter the customer's OTP `P`
**As a** Pro **I want** to enter the code and start **so that** my time is counted.
- **State:** Verified with the provider → `Booking.startedAt` set, `status = started`.
- **Ripple:** **This is the only thing that starts the timer — and therefore the only basis for my commission.**
- **Edge:** Verification is the provider's answer, never the app's claim.

### US-4.13 · Mistype the OTP `P`
- **State:** `startOtpAttempts` incremented; `startedAt` stays null; **the grace-window clock keeps running.**
- **Edge:** After a few failures, offer the customer a resend. A mistyped digit is far more common than fraud.

### US-4.14 · Arrive but be unable to start `P` `A` `S`
**As a** Pro stuck with building security **I want** the situation handled **so that** I'm not blamed.
- **State:** Grace window expires → `SupportTicket`, `category = no_start`, `raisedByType = system`, `isInternal = true`.
- **Ripple:** **Ops sees it. I am never told it exists** — deliberately, per the scope document.
- **Edge:** Legitimate causes are common — nobody home, wrong address, customer asleep. Ops must close them as benign without penalising me.

### US-4.8 · Message the customer `C` `P`
- **State:** `ChatMessage` scoped to the booking. Neither side sees the other's number.
- **Ripple:** The thread survives as dispute evidence.

### US-4.16 · Complete with photo proof `P`
**As a** Pro **I want** to submit completion photos **so that** my work is documented.
- **State:** `JobPhotoProof` rows, geo-stamped; `completedAt` and `actualDurationMinutes` set.
- **Ripple:** Commission calculation triggers. `completedJobs` increments.
- **Edge:** **Completion is blocked without at least one photo.** With quality audits gone, these photos are the platform's only structured record of what the finished work looked like — and my primary defence in a dispute.

### US-4.17 · Work as long as the job takes `P` `S`
**As a** Pro **I want** to do the job properly **so that** it's not half-finished.
- **State:** `actualDurationMinutes` records reality.
- **Ripple:** **My commission does not change.** One rate per service — a four-hour job pays the same as a one-hour one.
- **Edge:** An overrun eats into my next booking. Dispatch must detect the collision and reassign or alert ops.

### US-13.2 · Have my location tracked on duty `P` `S`
- **State:** Redis GEO index; periodic cold flush to `Pro.lastKnownLat/Lng`.
- **Ripple:** Feeds candidate proximity and the customer's tracking map.
- **Edge:** **Tracking must stop when I'm off duty.** Continuously tracking an off-duty employee is a consent problem before it is a battery one.

---

# 5 · Getting paid

### US-6.16 · See what I've earned today `P`
- **State:** Read of `BookingCommission`, computed at each completion.
- **Edge:** **Commission only.** Salary isn't tracked here, and a screen implying otherwise creates an expectation the system can't meet.

### US-8.5 · Have commission computed the moment I finish `S` `P`
- **State:** `Service.commissionType` and `commissionValue` read and **snapshotted** onto `BookingCommission`.
- **Ripple:** My live earnings update immediately — no end-of-day wait.
- **Edge:** Duration comes from the OTP-verified start. **No verified start, no defensible duration, no commission.**

### US-8.3 · Not have my past pay rewritten `A` `P`
**As a** Pro **I want** last month's earnings to stay what they were **so that** I can trust my statement.
- **State:** Rate snapshotted at computation. An admin editing the service tomorrow cannot restate what I was paid yesterday.
- **Edge:** The rate lives on the catalogue row, which ops edits for unrelated reasons. Snapshotting is what protects me.

### US-8.7 · Earn an incentive `S` `P`
- **State:** `ProIncentiveProgress` reaches target; reward credited against the triggering commission row.
- **Edge:** A later reversal of that job must decrement the progress, or a cancelled job banks a permanent bonus.
- **Open:** The scope document says only "incentive tracking" — the criteria and crediting rules are undefined.

### US-8.9 · Get one clean transfer per period `S` `P`
- **State:** `CommissionPayout` aggregating commissions, incentives and deductions into `netAmount`.
- **Edge:** Only `approved` commissions are gathered — a disputed job under review must not be swept in and then reversed.

### US-8.11 · Know when a payout fails `S` `A` `P`
**As a** Pro **I want** a failed transfer visible **so that** I still get paid.
- **State:** `CommissionPayout.status = failed`; the underlying commissions stay unpaid.
- **Ripple:** I see "payment failed", not silence.
- **Edge:** Commissions must **not** be marked paid until disbursement confirms.

### US-8.12 · See what a payout covered `P`
- **State:** Read of `CommissionPayout` and its constituent commission rows.
- **Edge:** **Must stay readable if I'm suspended.** Money already earned is still owed.

### US-8.14 · Have a reversal deducted, not clawed back `A` `P`
**As a** Pro **I want** a reversed commission handled openly **so that** money isn't taken from my account.
- **State:** The reversal becomes a **deduction on my next payout**, itemised.
- **Edge:** **Money is never debited from a Pro's bank account.** A visible deduction I can query is recoverable; a surprise debit is a dispute.

---

# 6 · My standing

### US-6.19 · See my rating and acceptance rate `P`
**As a** Pro **I want** to see how I'm measured **so that** I know where I stand.
- **State:** Read of `ratingSum` / `ratingCount` and `acceptanceRate`.
- **Edge:** **Only one of these affects my work.** Rating drives allocation; acceptance rate is a number. Showing them side by side as equals implies a consequence that doesn't exist.

### US-6.17 · Watch my acceptance rate move `P` `S`
- **State:** `assignmentsOffered` increments on every push; `assignmentsAcknowledged` on every in-time ack.
- **Ripple:** **Nothing automatic.** It doesn't feed the tie-break, doesn't change my commission, doesn't change my rank.
- **Edge:** **This is why it's harmless.** An undelivered push, a dead token or an outage would otherwise penalise me for a platform failure. As a reporting figure it costs me nothing.
- **Edge:** Show the raw counts beside the percentage. "3 of 4" reads very differently from "30 of 400" and I deserve to see which one I am.

### US-10.12 · Lose work through poor ratings `S` `P`
- **State:** `ratingSum` / `ratingCount` feed the tie-break as a smoothed score.
- **Ripple:** A poorly-rated Pro measurably loses assignments — and therefore commission. **This is the only Pro attribute that does that.**
- **Edge:** Smoothing means one bad review can't crater me. It also means a sustained pattern will show, and I can't hide it behind a small sample.

### US-6.18 · Start with no reviews at all `P` `S`
**As a** newly approved Pro **I want** to receive work despite having no record **so that** I can build one.
- **State:** `ratingCount = 0`. Ranking uses a smoothed score, so I evaluate to `dispatch.ratingPriorMean` — the platform average.
- **Ripple:** **I rank as a typical Pro, not as a last resort.** I lose to the genuinely excellent, which is right, and I win enough to start accumulating real reviews.
- **Edge:** My first review moves me a lot; my fifteenth barely at all. That is intentional — the prior fades as my real record accumulates.
- **Edge:** No badge, no probation flag, no expiry. Nothing about me says "new" — I'm just a Pro whose score happens to be close to average until my reviews say otherwise.

### US-10.2 · Consult reference material on site `P`
- **State:** Read only.
- **Edge:** Must work on poor connectivity — cache it. With no quality audits, the in-app checklist is the only thing enforcing a standard on a live job.

---

# 7 · When things go wrong

### US-11.2 · Raise an SOS `P` `A`
**As a** Pro at a site where I don't feel safe **I want** one tap to raise an alarm **so that** I'm not on my own.
- **State:** `SosAlert` with `raisedByType = pro`, live location, booking context.
- **Ripple:** Ops alerted immediately. **The customer is not told I raised it** — that could escalate the situation it exists to defuse.
- **Edge:** Must work backgrounded and on poor signal.

### US-11.4 · Raise a false alarm without penalty `P` `A`
- **State:** `status = false_alarm`. No consequence, and it never appears on my profile.
- **Edge:** Hesitation to press the button is the failure mode that matters.

### US-11.6 · Raise a ticket `P` `A`
**As a** Pro **I want** to report an app problem or a payment query **so that** it gets fixed.
- **State:** `SupportTicket` with `raisedByType = pro`.
- **Edge:** **I must never see tickets where `isInternal = true`**, including ones about me. Enforced server-side, not by hiding a tab.

### US-6.9 · Be suspended from one service `A` `P`
**As a** Pro **I want** a problem with one trade not to stop all my work **so that** my income continues.
- **State:** `ProService.isActive = false` for that service only.
- **Ripple:** Excluded from that service's pools; unaffected for others.
- **Edge:** With quality audits gone, this is the primary tool for acting on a complaint. The reasoning lives in the `SupportTicket` that prompted it.

### US-6.10 · Be suspended entirely `A` `P` `C`
- **State:** `Pro.status = suspended`.
- **Ripple:** All future dispatch excluded. Any **live booking needs explicit handling** by ops.
- **Edge:** **Earnings already accrued remain payable.** Suspension is not forfeiture.

### US-1.8 · Be locked out while suspended `P` `A`
- **State:** Login refused for job flows.
- **Edge:** I should keep read access to earnings and payout history.

### US-6.11 · Be reinstated `A` `P`
- **State:** `Pro.status = approved`.
- **Ripple:** Re-enters pools — if `isAvailable` is true **and** at least one `ProService` is active.
- **Edge:** **Three gates, all must pass.** Reinstating status while services stay suspended leaves me approved and still getting nothing.

### US-5.15 · Be pulled off a live job `A` `P` `C`
- **State:** Suspension mid-assignment; dispatch re-runs and the customer sees a new Pro.
- **Edge:** If I've already arrived, cancelling remotely is worse than ops handling it by phone.

### US-10.6 · Be sent for retraining `A` `P`
- **State:** `ProTrainingProgress` reset for the relevant modules; `SupportTicket.actionTaken = retraining`.
- **Edge:** **The ticket is the only record of why.** Closed without notes, the reset is unexplained.

---

# 8 · Things that happen to me

Decisions made about a Pro that they neither initiate nor can appeal.

| What happens | Where it's decided | Story |
|---|---|---|
| **I'm switched on or off duty** | An admin sets `isAvailable`. I have no control over it and no way to do it myself | [US-6.14](../user-stories/06-pro-management.md) |
| **A job is assigned to me** — I cannot decline | Availability, proximity, rotation, then smoothed rating | [US-5.1](../user-stories/05-dispatch-engine.md) |
| **A job is taken away** because I didn't acknowledge fast enough | `ackDeadlineAt` expires; the engine moves to the next candidate | [US-5.3](../user-stories/05-dispatch-engine.md) |
| **I'm skipped for a nearby job** | Rotation cooldown — I served that address last time | [US-5.6](../user-stories/05-dispatch-engine.md) |
| **A ticket is opened about me and I'm never told** | No-start incident, `isInternal = true` | [US-11.7](../user-stories/11-safety-and-support.md) |
| **My commission rate changes** | An admin edits `Service.commissionValue`. Past jobs are protected by snapshotting; future ones are not | [US-8.1](../user-stories/08-commission-and-payouts.md) |
| **My acknowledgement window changes** | `PlatformSetting assignment.ackWindowSeconds`, optionally per city | [US-14.2](../user-stories/14-config-and-sdui.md) |
| **How my few reviews are weighted changes** | `dispatch.ratingPriorMean` and `priorWeight` decide how a newer Pro ranks against an established one | [US-5.17](../user-stories/05-dispatch-engine.md) |
| **Ops hands my job to someone else** | Manual override, recorded on the booking with a reason | [US-5.12](../user-stories/05-dispatch-engine.md) |
| **My rating changes** | A customer reviews the job; the counters feed my dispatch rank | [US-4.18](../user-stories/04-booking-and-job-lifecycle.md) |

---

## Settled decisions worth knowing

| Question | Answer |
|---|---|
| **Who sets `isAvailable`?** | Ops. I'm a salaried employee and supply is planned centrally. Every toggle is audited, so a day I got no work is explainable |
| **Does a missed push hurt my standing?** | No. Acceptance rate is reporting only — a platform failure never costs me future work |
| **How do I rank before I have reviews?** | At the platform average, via a smoothed score. I compete from day one and my real record takes over as it accumulates |

## Open questions affecting Pros

| Question | Why it matters |
|---|---|
| **Does `isAvailable` auto-clear at end of day?** | Left on overnight, I'm dispatched work at 6am and time out on it. Undecided |
| **How do I tell ops I'm unwell at 6am?** | I can't switch myself off, so this needs a real channel — not just a toggle in the console |
| **How is overrun work compensated?** | One rate per service means a 4-hour job pays the same as a 1-hour one. Incentives are the only remaining lever |
| **Does a hidden review still count toward my rating?** | Rating is now the *only* thing driving my work allocation, so this matters more than it used to |
