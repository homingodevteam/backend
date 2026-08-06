# Customer — User Stories

Everything the person booking a service can do, and everything the system does to them.
**Conventions:** [README](README.md) · **Module view:** [`../user-stories/`](../user-stories/README.md)

---

## What a customer controls

Their account, their addresses, what they book and when, whether they pay, whether they cancel, and what they say about the job afterwards.

## What a customer does not control

**Who turns up.** They cannot request a specific Pro, and the rotation rule may deliberately send someone different from last time. They cannot see, influence or appeal a dispatch decision.

## What a customer never sees

The platform/Pro commission split. The Pro's internal standing figures. Any internal ticket — including the no-start incident raised when their Pro arrives but doesn't begin. Whether their Pro raised an SOS.

---

# 1 · Discovering and signing up

### US-1.1 · Browse before signing up `C`
**As a** first-time visitor **I want** to browse services and see prices without creating an account **so that** I can decide whether the platform is worth signing up for.
- **State:** `Customer` row created with `deviceId`, `status = guest`, `phone` null.
- **Ripple:** None. Guests are invisible to dispatch and to admin lists.
- **Edge:** Reinstalling the app produces a new `deviceId` and a new guest row. Orphan guests with no phone and no booking need purging on a schedule.

### US-1.2 · Sign up with phone OTP `C`
**As a** customer **I want** to sign up with just my phone number **so that** I can book without a password.
- **State:** OTP requested from the third-party provider; on verify, `phone` written to the existing guest row, `status = verified`, `verifiedAt` set.
- **Ripple:** The customer becomes visible in admin search and can be assigned bookings.
- **Edge:** If that phone already belongs to a **different verified** `Customer`, the guest row must be discarded and the session attached to the existing customer — otherwise one person ends up with two accounts and split history.

### US-1.3 · Keep what I did as a guest `C`
**As a** guest who already pinned an address **I want** it still there after verifying **so that** I don't re-enter everything.
- **State:** The guest row is upgraded in place; `CustomerAddress` rows already point at it.
- **Ripple:** None.
- **Edge:** Only works because the guest row *is* the customer row. Creating a fresh row on verification would strand the addresses.

### US-1.4 · Use the same number as my Pro account `C` `P`
**As a** Pro who also books services at home **I want** to use one phone number **so that** I don't need a second.
- **State:** `Customer.phone` and `Pro.phone` are unique within their own tables, so the same number exists in both.
- **Ripple:** The identities are separate and never merged.
- **Edge:** Dispatch must never assign a Pro to their own booking. Compare phones and exclude on match, or rotation and review data become self-referential.

### US-1.5 · Request another OTP `C`
**As a** customer who didn't get the code **I want** to request another **so that** I'm not locked out by a carrier delay.
- **State:** New provider request; the previous code is invalidated.
- **Ripple:** None.
- **Edge:** Rate-limited per phone **and** per device, or the platform becomes an SMS-bombing tool. Delivery is billed per message, so this is a cost control too.

### US-1.6 · Be stopped after repeated wrong codes `C`
**As the** platform **I want** to stop accepting attempts after several failures **so that** codes cannot be brute-forced.
- **State:** Per-phone cooldown, duration from `PlatformSetting`.
- **Edge:** Keyed on the phone number, not the session — clearing app data must not reset it.

### US-1.7 · Be blocked `C` `A`
**As** ops **I want** an abusive customer unable to book **so that** they stop ordering.
- **State:** `Customer.isBlocked = true`.
- **Ripple:** Login may still succeed so they can reach support, but booking creation is refused. **In-flight bookings are not auto-cancelled** — ops decides case by case.
- **Edge:** Decide whether a blocked customer keeps access to order history and tickets. Blocking everything removes their route to appeal.

---

# 2 · Setting up my addresses

### US-2.1 · Pin my address precisely `C`
**As a** customer in a large complex **I want** to drag the pin to my actual door **so that** the Pro doesn't wander around the block.
- **State:** `CustomerAddress` with `pinLat`, `pinLng`, `geoPoint`; text address stored separately.
- **Ripple:** **Dispatch routes to the pin.** Travel time, ETA and the arrival geo-stamp all depend on it.
- **Edge:** If pin and typed address disagree wildly, warn but let the pin win.

### US-2.2 · Save several labelled addresses `C`
**As a** customer **I want** home, office and my parents' place saved separately **so that** I can book for any of them.
- **State:** Multiple `CustomerAddress` rows, one `isDefault`.
- **Ripple:** **Rotation is tracked per address**, so the same Pro rotates independently at each.
- **Edge:** Two addresses with near-identical pins are legitimate — flats in one building. Do not dedupe on proximity.

### US-2.3 · Set a default `C`
**As a** customer **I want** my usual address preselected **so that** booking is two taps instead of four.
- **State:** `Customer.defaultAddressId`; previous default cleared.
- **Edge:** Deleting the default must promote another or null the pointer, or the booking screen breaks.

### US-2.4 · Be stopped from moving an address mid-job `C`
**As the** platform **I want** to refuse repointing during a live booking **so that** a Pro is not redirected while travelling.
- **State:** Edit refused while any booking on that address is between `assigned` and `completed`.
- **Ripple:** The assigned Pro's navigation target stays stable.
- **Edge:** Offer "create a new address instead". Silently allowing it sends the Pro across the city mid-route.

### US-2.5 · Delete an old address `C`
**As a** customer **I want** to remove an address I no longer use **so that** my list stays short.
- **State:** Soft delete only — bookings and rotation history still reference it.
- **Edge:** A hard delete breaks historical bookings, invoices and any dispute about where the job happened.

### US-2.6 · Be told my area isn't covered `C`
**As a** customer outside coverage **I want** to know before I pick a service **so that** I don't waste time.
- **State:** Address saved, booking refused.
- **Edge:** Capture these attempts — refused bookings by location are the cleanest signal for where to expand.

### US-2.7 · Correct my name or email `C`
**As a** customer **I want** to fix my details **so that** my invoice is right.
- **State:** `Customer.fullName`, `email` updated.
- **Ripple:** Future invoices use the new values. **Already-issued invoices are not regenerated.**
- **Edge:** Email is optional and never a login credential.

### US-2.8 · Have the address auto-fill from my pin `C`
**As a** customer **I want** the address to fill in when I drop a pin **so that** I don't type it.
- **State:** Reverse geocode via OpenStreetMap; text stored alongside the coordinates.
- **Edge:** The geocoded text is convenience. **The pin remains authoritative for routing.**

---

# 3 · Browsing and choosing

### US-3.1 · Browse categories and services `C`
**As a** customer **I want** to browse by category **so that** I can find what I need.
- **Edge:** Inactive services vanish from browse but stay resolvable by id, so historical bookings still render their name.

### US-3.2 · See one flat price `C`
**As a** customer **I want** a single final number **so that** there are no surprises at the end.
- **State:** `Service.flatPrice` on browse, booking summary, invoice and history — the same number every time.
- **Ripple:** **The platform/Pro split never appears on any customer-facing surface.**
- **Edge:** Any screen showing a total must read the frozen `Booking.flatPrice`, not recompute from the live catalog.

### US-3.3 · See a home screen that changed without an app update `C` `A`
**As a** customer **I want** current offers and categories **so that** the app feels alive.
- **State:** `UiConfig` JSON tree served from CDN, scoped by city and segment.
- **Ripple:** Marketing changes layouts with no app release.
- **Edge:** If my app is old, `minAppVersion` gating must serve a tree it can render — otherwise the home screen goes blank.

---

# 4 · Booking

### US-4.1 · Book an instant service `C`
**As a** customer with a burst pipe **I want** someone now **so that** the problem stops.
- **State:** `Booking` created, `bookingType = instant`, price frozen, `status = created`.
- **Edge:** If no Pro is free right now, say so **before** taking payment. Charging then failing to assign is the worst possible order.

### US-4.2 · Pick a scheduled slot `C`
**As a** customer **I want** to choose from real availability **so that** the time I pick is one someone can work.
- **State:** Slots come from the dispatch engine's free-window computation.
- **Ripple:** **Choosing a slot does not reserve a Pro** — assignment happens later.
- **Edge:** Two customers can pick the same slot. Both bookings are valid; dispatch resolves supply afterwards. Over-selling a scarce slot is the failure to watch.

### US-4.3 · Set up recurring cleaning `C`
**As a** customer **I want** weekly cleaning **so that** I don't rebook every week.
- **State:** `RecurringPlan` with frequency, days, time, `nextRunAt`; a job generates each booking ahead of time.
- **Edge:** If my card fails on one occurrence, **do not silently cancel the plan.** Retry and notify — losing a weekly cleaner to one expired card is a churn event.
- **Open:** Is a recurring booking priced when the plan was created, or when each occurrence generates? Currently the latter.

### US-4.5 · Rebook a past service `C`
**As a** customer **I want** to repeat a job in one tap **so that** it's effortless.
- **State:** New `Booking` with `rebookedFromBookingId`; service, address and preferences copied.
- **Ripple:** **Rotation still applies — a rebook does not guarantee the same Pro.**
- **Open:** If I explicitly want the same Pro, that conflicts with rotation. Unresolved; rotation currently wins.

### US-4.23 · Book two services for the same morning `C`
**As a** customer **I want** a cleaner and an electrician on one day **so that** I only take one day off.
- **State:** Two independent bookings, two independent dispatch runs, two Pros routed to the same pin.
- **Edge:** Rotation is tracked per address across *all* services, so booking two could push both toward less-preferred Pros.

---

# 5 · Paying

### US-7.1 · Pay by UPI `C`
**As a** customer **I want** to pay by UPI **so that** it's quick.
- **State:** `Order` created server-side **before** checkout opens. On capture: `Booking.paymentStatus = paid`.
- **Edge:** The order must exist before checkout — creating it client-side would let the amount be tampered with.

### US-7.2 · Retry with a different method `C`
**As a** customer **I want** to try a card when UPI times out **so that** a bank hiccup doesn't lose my booking.
- **State:** One `Order`; `attempts` and `failureCode` mirror the gateway. **The attempts themselves live at Razorpay, not locally.**
- **Edge:** To show me both attempts, support calls Razorpay with the order id.

### US-7.3 · Use a saved card `C`
**As a** returning customer **I want** my card offered **so that** I don't retype it.
- **State:** Instrument lives at Razorpay against `Customer.razorpayCustomerId`.
- **Edge:** No card number or VPA ever touches the platform database.

### US-7.5 · Understand why payment keeps failing `C` `A`
**As a** customer **I want** to know why **so that** I can fix it.
- **State:** `Order.failureCode` holds the **most recent** failure only.
- **Ripple:** Booking stays `awaiting_payment` and eventually expires.

### US-7.6 · Not be able to fake a successful payment `C` `S`
**As the** platform **I want** to reject unverified success claims **so that** a tampered app cannot get free services.
- **State:** Nothing marked paid. **Signature verification is server-side and non-negotiable.**

### US-4.6 · Abandon checkout `C` `S`
**As the** platform **I want** unpaid bookings to expire **so that** the pipeline isn't clogged.
- **State:** Stays `awaiting_payment`; a job cancels it after a configured hold window.
- **Edge:** If I pay *after* the expiry job runs, the webhook arrives for a cancelled booking — the payment is recorded then immediately refunded.

---

# 6 · Waiting for my Pro

### US-12.1 · Be told who's coming `C` `S`
**As a** customer **I want** to know who's assigned **so that** I can expect them.
- **State:** `NotificationLog` linked to the booking; push to `Customer.pushToken`.
- **Edge:** If the assignment changes after a no-ack timeout, send a **correction**, not a second arrival notice. Two messages naming different people reads as two Pros arriving.

### US-4.7 · Watch the Pro approach `C`
**As a** customer **I want** live position and ETA **so that** I know when to expect them.
- **State:** Position and ETA read from Redis, never written to the booking.
- **Edge:** If the Pro's phone loses signal, show a stale-position warning. A frozen pin reads as "they've parked", not "we lost them".

### US-12.7 · Still get critical updates with push muted `C`
**As a** customer who muted notifications **I want** arrival alerts another way **so that** I don't miss the Pro.
- **State:** Fallback to SMS or WhatsApp for critical templates only.
- **Edge:** Classify templates. Falling back for marketing is spam; falling back for "your Pro has arrived" is service.

---

# 7 · The job

### US-4.8 · Message the Pro `C` `P`
**As a** customer **I want** to tell them about the broken gate **so that** they can get in.
- **State:** `ChatMessage` scoped to the booking. Neither side sees the other's number.
- **Ripple:** The thread survives as dispute evidence.
- **Open:** Chat must close some period after completion, or it becomes an unmonitored channel between strangers.

### US-4.11 · Receive the start OTP `C`
**As a** customer **I want** a code when the Pro arrives **so that** work only begins with my consent.
- **State:** Third-party OTP dispatched; `Booking.startOtpProviderRef` recorded. The Pro's app shows a code-entry field.
- **Ripple:** **The job cannot start until this lands and I give the code.**
- **Edge:** If the person at the door isn't me — I sent a relative — the code still goes to my phone. Support needs a documented override.

### US-12.4 · Actually receive that OTP `C` `S`
**As a** customer **I want** the code to arrive reliably **so that** the Pro isn't left waiting at my door.
- **State:** Via the OTP provider, typically WhatsApp with SMS fallback.
- **Edge:** A Pro is physically standing outside. Failure here needs an immediate resend path, not a support ticket.

### US-4.15 · Not be home when they arrive `C` `P` `A`
**As a** customer who got delayed **I want** a sensible outcome **so that** I'm not just charged for nothing.
- **State:** Pro reports it; ops decides — cancel (window D) or reschedule.
- **Ripple:** A no-start ticket has likely already been raised internally. The Pro is freed for other work.
- **Open:** Whether I'm charged a fee is undecided. The Pro is salaried so nothing is owed to them, but a wasted visit is a real cost.

---

# 8 · Afterwards

### US-4.18 · Rate the job `C`
**As a** customer **I want** to rate and comment **so that** good Pros are recognised.
- **State:** `Review` with rating, comment, tags; `Pro.ratingSum` and `ratingCount` incremented.
- **Ripple:** **My rating feeds the dispatch tie-break** — it measurably changes how much work that Pro gets.
- **Edge:** One review per booking. If editing is allowed, counters adjust by the delta.

### US-10.8 · Add photos to my review `C`
**As a** customer **I want** to show the finished work **so that** my review is credible.
- **State:** `Review.photoUrls`, capped by `PlatformSetting review.maxPhotos`.
- **Ripple:** Visible on the Pro's profile; usable as dispute evidence.
- **Edge:** These are **not** the Pro's `JobPhotoProof`. Different author, different trust level — never merged into one gallery.

### US-10.10 · Get a photo taken down `C` `A`
**As a** customer who regrets posting a photo of my living room **I want** it removed **so that** my home isn't public.
- **State:** `Review.isHidden` with reason and admin attribution.
- **Edge:** I uploaded it myself, so this is regret rather than complaint. A self-service takedown avoids forcing me through support.

### US-3.2b · See an invoice showing only what I agreed to `C`
**As a** customer **I want** the invoice to show ₹200 **so that** nothing is ambiguous.
- **State:** `invoiceNumber`, `invoicePdfUrl`, `taxAmount`, `invoicedAt` on the booking.
- **Ripple:** The platform/Pro split lives in `BookingCommission` and never reaches this document.

---

# 9 · When it goes wrong

## Cancelling

### US-4.19 · Cancel before anyone is assigned `C`
- **State:** Window A/B — `cancelled`, `cancelledByType = customer`, full refund if paid.
- **Ripple:** Dispatch queue entry removed. No Pro affected.

### US-4.20 · Cancel while the Pro is on the way `C` `P`
- **State:** Window D — assignment closed, full refund less any configured fee.
- **Ripple:** **The Pro is freed immediately.** Nothing is owed to them — they're salaried.
- **Edge:** The Pro must be told promptly, or they keep driving to a job that no longer exists.

### US-4.21 · Stop work that's going wrong `C` `A`
- **State:** Window E — cancelled after `started`. Refund partial, at ops discretion.
- **Edge:** The messiest window and the most likely to become a dispute. Requires an ops decision, not an automated percentage.

### US-4.22 · Have my booking cancelled because nobody could come `A` `C` `S`
- **State:** `cancelledByType = ops`; full refund.
- **Ripple:** I'm notified with an apology and ideally a rebooking offer.
- **Edge:** Should be rare and always investigated. A cluster in one area is a supply problem, not bad luck.

## Refunds

### US-7.10 · Get my money back `A` `C`
- **State:** Razorpay refund; `Order.refundStatus = initiated`; `Booking.refundedAmount` set; ledger entry written **now**.
- **Ripple:** I'm notified with the expected settlement window.

### US-7.11 · Know when the money actually lands `S` `C`
- **State:** `refund.processed` webhook → `refundStatus = settled`; I'm notified again.
- **Edge:** Initiated and settled are 5–7 working days apart. Collapsing them into one state generates a support ticket for every refund.

### US-7.12 · Get a partial refund `A` `C`
- **State:** `Order.refundAmount`; `Booking.refundedAmount` and `cancellationFeeAmount` record the split.

## Safety and support

### US-11.1 · Raise an SOS `C` `A`
**As a** customer alone at home who feels unsafe **I want** one tap to raise an alarm **so that** someone responds immediately.
- **State:** `SosAlert` with live location and a full booking context snapshot.
- **Ripple:** **Ops alerted immediately**, bypassing normal queues.
- **Edge:** Must work backgrounded and on poor signal. An SOS needing three taps and a good connection is not an SOS.

### US-11.4 · Raise a false alarm without penalty `C` `A`
- **State:** `status = false_alarm`. **No consequence for me.**
- **Edge:** Never penalise a false alarm. Hesitation to press the button is the failure mode that matters.

### US-11.5 · Ask why I was charged `C` `A`
- **State:** `SupportTicket`, `category = billing`.
- **Edge:** Support answers the amount, status and refund from `Order` and the ledger. Anything about a payment *attempt* — a retry, a duplicate charge — they look up in the Razorpay dashboard; the console doesn't carry it.

### US-11.10 · Dispute a completed job `C` `A` `P`
**As a** customer unhappy with the work **I want** it put right **so that** I'm not out of pocket.
- **State:** `SupportTicket`, `category = dispute`.
- **Ripple:** Ops reviews evidence the system already holds — status timeline with coordinates, the Pro's photo proof, route trail, chat log, my own review photos.
- **Edge:** A completed job is **disputed, never cancelled.** Different evidence bar, different consequence for commission.

### US-11.13 · Have my dispute rejected `A` `C`
- **State:** `resolved` with `resolutionNotes`. No refund.
- **Edge:** The reasoning must reference the evidence. "Rejected" with no explanation converts a resolved dispute into an escalation.

---

# 10 · Things that happen to me

Decisions made about a customer's booking that they neither see nor influence.

| What happens | Where it's decided | Story |
|---|---|---|
| **Which Pro is sent** | Availability, then proximity, then rotation, then a smoothed rating score | [US-5.1](../user-stories/05-dispatch-engine.md) |
| **A different Pro from last time** — deliberately | The rotation rule deprioritises whoever served this address last | [US-5.6](../user-stories/05-dispatch-engine.md) |
| **The assigned Pro silently changes** before arrival | The first Pro didn't acknowledge in time; the engine moved on | [US-5.3](../user-stories/05-dispatch-engine.md) |
| **A Pro is pulled off my job** | Suspension, absence or an ops override | [US-5.15](../user-stories/05-dispatch-engine.md) |
| **An internal ticket is opened about my booking** | My Pro arrived but didn't start inside the grace window. Ops handles it; neither I nor the Pro is told | [US-11.7](../user-stories/11-safety-and-support.md) |
| **My Pro raises an SOS** | I am deliberately **not** notified — telling me could escalate the situation | [US-11.2](../user-stories/11-safety-and-support.md) |
| **My booking is priced at the catalogue rate of that moment** | Recurring occurrences take the price when generated, not when the plan was made | [US-3.5](../user-stories/03-service-catalog.md) |

---

## Open questions affecting customers

| Question | Why it matters |
|---|---|
| Is there a cancellation fee, and in which windows? | Windows D and E currently have no defined charge |
| Can I request the same Pro again? | Directly conflicts with the rotation rule |
| Recurring price — fixed at plan creation, or current at generation? | Changes what a customer thinks they signed up for |
| When does booking chat close? | Currently open indefinitely between two strangers |
| Does a hidden review still count toward the Pro's rating? | Affects whether moderation is meaningful |
