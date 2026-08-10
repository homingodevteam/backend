# Module 5 — Dispatch Engine · Implementation Plan

**Date:** 2026-08-10
**Status:** plan only — no module 5 code written yet.

Written against [`Modules_and_Features 1.md`](Modules_and_Features%201.md) §5, the
ground-rules table, [`ERD_DATA_MODEL_V10.md`](ERD_DATA_MODEL_V10.md), and the
eleven US-5.x stories.

> Module 4 already defines the interface this module implements —
> `DispatchPort`, currently bound to a no-op. **Landing module 5 is swapping one
> `provide` line**, not threading a new concern through the booking lifecycle.

---

## 1 · Where the code stands today

| Thing                     | State                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/dispatch/`   | **Does not exist.**                                                                                                               |
| `AssignmentCandidate`     | Stub — 5 of the ERD's 16 scoring columns. No `rank`, `finalRankScore`, travel, origin or window fields.                           |
| `DispatchPort`            | ✅ Defined by module 4, bound to `NoOpDispatchService`. The seam is ready.                                                        |
| `Booking` assignment cols | ✅ All present — `proId`, `assignmentAttempt`, `assignedAt`, `notifiedAt`, `ackDeadlineAt`, `acknowledgedAt`, `assignmentOutcome` |
| `ProCountersService`      | ✅ `recordOffer` / `recordAcknowledgement` built — **and still have no caller.** This module is it.                               |
| Redis                     | ✅ `setIfAbsent` (the `SET NX PX` lock), `geoPosition`, `geoAdd`, `scanKeys`, `del`                                               |
| `PlatformSetting`         | ✅ `dispatch.ratingPriorMean` = 4, `dispatch.ratingPriorWeight` = 5 already seeded                                                |
| `Booking` rotation index  | ✅ `@@index([addressId, proId, completedAt])` — exactly what rule 3 queries                                                       |

Almost every dependency this module needs was built in advance. What is genuinely
missing is **travel time** (module 13) and **push** (module 12).

---

## 2 · Contradictions and decisions

### 2.1 Rule 2 needs travel time; Geo & Routing does not exist

Feature 6 ranks by "computed travel time from that origin to the customer's exact
pin". Module 13 owns that and is not built.

**Recommendation:** a third port, `TravelTimePort`, owned by this module. The
stand-in computes **haversine distance and divides by a configurable average
speed** (`dispatch.assumedSpeedKmph`, default 20 — Indian city traffic).

Unlike module 4's payment stub, this one deliberately **does** return a usable
answer, because a straight-line estimate genuinely ranks candidates correctly
most of the time — proximity ordering rarely inverts between crow-flight and
road distance at city scale. It is wrong for _quoting an ETA to a customer_, so
the ETA half of feature 15 stays deferred rather than publishing a number we
cannot stand behind.

### 2.2 "Redis-queued intake" with no worker process

Feature 1 wants one queued job per booking. This codebase has no job runner at
all — module 4's recurring generator is an admin-triggered route for the same
reason.

**Recommendation:** implement the queue for real (a Redis list, `LPUSH` on
booking creation) and drain it from **two** triggers: an admin route, and an
in-process interval the app starts on boot. That gives genuine asynchronous
intake without inventing infrastructure, and swapping in BullMQ later replaces
the drain loop only. The lock (feature 2) is what makes the drain safe to run
from anywhere, so the trigger mechanism is not load-bearing.

### 2.3 US-5.5 and US-5.10 must not look the same

> **US-5.5:** empty pool at Rule 1; flagged as a **supply gap** rather than a
> dispatch failure. A structural supply problem dressed as a per-booking error
> will be triaged as a bug for months.
> **US-5.10:** `assignmentOutcome = exhausted`; ops alerted.

**Recommendation:** two distinct outcomes — `no_supply` (nobody holds this
service here, at all) and `exhausted` (candidates existed, all were tried or
excluded). Different values, different ops queues.

### 2.4 `acceptanceRate` must not influence ranking

Stated three times: the ground rules, feature 9, and US-5.3's "it costs me that
job, not future ones".

**Recommendation:** enforce structurally — the ranking function never reads
`acceptanceRate`, and a test asserts that two Pros differing _only_ in
acceptance rate rank identically.

### 2.5 `AssignmentCandidate` is missing 11 ERD columns

The stub carries `isWinner`, `ratingScore`, `offersToday`, `excludedReason`,
`evaluatedAt`. The ERD adds `windowStart`, `windowEnd`, `originType`,
`originLat`, `originLng`, `rank`, `distanceKm`, `travelTimeMinutes`,
`rotationScore`, `durationFitScore`, `finalRankScore`.

**Recommendation:** add all eleven. US-5.11 is explicit that a candidate row must
answer "why wasn't this Pro chosen?", and it cannot without the score inputs.
This is the module's whole audit story.

### 2.6 A Pro who was never a candidate vs one who ranked and lost

> **US-5.11 Edge:** A Pro who was **never a candidate** must be distinguishable
> from one who was ranked and lost. They are different conversations.

**Recommendation:** persist **excluded** Pros too, with `excludedReason` set and
`rank` null. A row exists for every Pro the engine considered; `rank` being null
is what says "filtered out before scoring".

---

## 3 · Schema

Only `AssignmentCandidate` changes. No new tables — the assignment itself lives
on `Booking`, which is the v10 decision that removed the `Assignment` table.

```prisma
windowStart        DateTime?
windowEnd          DateTime?
originType         String?   // current_location | last_job_location | home_base
originLat          Float?
originLng          Float?
rank               Int?      // null = excluded before scoring
distanceKm         Float?
travelTimeMinutes  Int?
rotationScore      Float?
durationFitScore   Float?
finalRankScore     Float?
```

Coordinates as `Float`, per [conflict #19](CONFLICTS_AND_DECISIONS.md).

---

## 4 · The algorithm

Four rules, in order. Every Pro evaluated produces a row.

**Rule 1 — availability.** Filter to Pros with an active `ProService` for the
service, `status = approved`, `isAvailable = true`, and a free window fitting the
slot. Free windows come from that Pro's **committed bookings alone** — there is
no roster — cached in Redis per Pro per day. Empty pool ⇒ `no_supply` (§2.3).

**Travel origin.** Next scheduled job's address if one exists, else live GPS from
the Redis GEO index, else home base. Recorded as `originType` so US-5.7 is
answerable after the fact.

**Rule 2 — proximity.** Rank by travel time from that origin to the customer's
exact pin.

**Rule 3 — rotation.** Deprioritise a Pro who served this household recently —
an indexed query over `Booking(addressId, proId, completedAt)` with the cooldown
from `PlatformSetting`. Not an exclusion: a penalty, so a rotation-cooled Pro
still wins over nobody.

**Rule 4 — tie-break**, in order: duration fit against the free window, then
**smoothed rating**, then fewest offers today, then lowest `Pro.id`. The final
tie-break on id exists so the ordering is deterministic and a rerun explains the
same way.

**Smoothed rating.** `(ratingSum + priorMean × priorWeight) / (ratingCount +
priorWeight)`. A Pro with no reviews sits at the platform average — no cold-start
flag, no expiry. Both constants already in `PlatformSetting`.

---

## 5 · API surface

| Method | Route                                     | Who                      |
| ------ | ----------------------------------------- | ------------------------ |
| `POST` | `/pros/me/bookings/:id/acknowledge`       | Pro                      |
| `GET`  | `/admin/dispatch/queue`                   | Admin                    |
| `POST` | `/admin/dispatch/drain`                   | Admin                    |
| `POST` | `/admin/dispatch/bookings/:id/run`        | Admin                    |
| `GET`  | `/admin/dispatch/bookings/:id/candidates` | Admin — US-5.9/5.11      |
| `POST` | `/admin/dispatch/expire-acknowledgements` | Admin — the no-ack sweep |
| `GET`  | `/admin/dispatch/unassignable`            | Admin — US-5.10/5.5      |

There is **no accept and no decline route**. Acknowledgement is receipt, not
agreement (US-5.2).

---

## 6 · Deferred

| Item                          | Blocked on      | Seam                                      |
| ----------------------------- | --------------- | ----------------------------------------- |
| Real road travel time / ETA   | Module 13       | `TravelTimePort`, haversine stand-in      |
| Push on assignment            | Module 12       | `notifiedAt` is set; nothing sends        |
| Pro-gone-dark alert (US-5.13) | Module 11/12    | Needs an alerting channel                 |
| ETA published continuously    | Modules 12 + 13 | Module 4's tracking view returns null ETA |

---

## 7 · Build order

| Phase | Work                                                                   |
| ----- | ---------------------------------------------------------------------- |
| A     | Schema: 11 columns on `AssignmentCandidate`; migration; settings       |
| B     | Scoring — free windows, origin, rotation, smoothed rating, tie-break   |
| C     | The engine — lock, evaluate, persist candidates, assign, counters      |
| D     | Acknowledgement + the no-ack retry sweep                               |
| E     | Queue intake and drain; bind `DispatchPort` to the real implementation |
| F     | Admin explainability routes                                            |
| G     | Specs + Swagger contract e2e                                           |
| H     | Docs — status report, conflicts #29+                                   |

---

## 8 · Definition of done

- [ ] Every evaluated Pro has a candidate row; excluded ones distinguishable by null `rank`
- [ ] A booking can never be double-assigned (lock + test)
- [ ] `acceptanceRate` provably not a ranking input
- [ ] `no_supply` and `exhausted` are different outcomes
- [ ] No accept/decline route exists at any depth
- [ ] `DispatchPort` bound to the real engine; module 4 unchanged
- [ ] A cash booking self-assigns end to end against the local database
