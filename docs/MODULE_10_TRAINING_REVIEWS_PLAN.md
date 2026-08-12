# Module 10 — Training & Reviews · Implementation Plan

**Date:** 2026-08-12 · **Built:** 2026-08-12
**Status:** ✅ **Built.** §16 records where the code departed from this plan and
what was verified against the real database.
**Estimated size:** ~3,000 lines across **two folders**, 24 endpoints, 4 new
tables, 2 altered. Roughly module 9 plus a half.
**Actual:** 5,538 lines (4,363 code + 1,175 spec), **29 endpoints**, 4 new
tables, 2 altered.

---

## 0 · Where the code already stands

More of this module exists than the feature list suggests — and one piece of it
is a live hazard.

| Thing                                          | State                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Review` table                                 | ✅ Exists in Prisma. **Zero rows are ever written** — nothing calls the writer                              |
| `ProCountersService.recordReview`              | 🟠 84 lines, correct, **no caller anywhere**. Dead code in module 6's folder                                |
| `Pro.ratingSum` / `ratingCount`                | ✅ Columns exist, nightly rebuild exists                                                                    |
| Nightly rebuild                                | ⚠️ **Rebuilds Pro rating from every row in `reviews`, unfiltered.** See §1                                  |
| Rating → dispatch                              | ✅ Done. `smoothedRating()` in `dispatch.types.ts`, weight 0.15. Nothing to build                           |
| `GET /pros/me/ratings`                         | ✅ `ProStandingService.ratings()` — and it already strips `comment`/`tags` when `isHidden`                  |
| Presigned upload / view                        | ✅ `S3Service.createUploadUrl` / `createViewUrl`                                                            |
| `Customer.isBlocked` + `CUSTOMER_MODERATE`     | ✅ Both exist. **Ops already has the lever** for a bad customer — what is missing is the evidence beside it |
| `PlatformSettingsService`                      | ✅ Exported from `bookings.module.ts`, city-override aware                                                  |
| All 4 training tables                          | ❌ In the ERD, absent from Prisma                                                                           |
| `reviewerType`, `photoUrls`, `hiddenByAdminId` | ❌ Absent                                                                                                   |
| `Customer.ratingSum` / `ratingCount`           | ❌ Absent                                                                                                   |
| Every endpoint in this module                  | ❌                                                                                                          |

The useful conclusion: **customer→Pro rating is already wired end to end except
for the one endpoint that creates a row.** Dispatch consumes it, the nightly job
rebuilds it, the Pro app displays it. Feature 15 is ninety percent done.

---

## 1 · CONFLICTS_AND_DECISIONS #61 — the second reviewer direction silently rewrites every Pro's rating

This is the one thing in this module that can do real damage, and it does it
quietly, six hours after the deploy.

`ProCountersService.rebuildAll` runs at 02:00 IST and contains:

```sql
WITH ratings AS (
  SELECT "proId", SUM("rating")::int AS sum, COUNT(*)::int AS count
  FROM "reviews" GROUP BY "proId"          -- ← every row. No direction filter.
)
UPDATE "pros" SET "ratingSum" = ..., "ratingCount" = ...
```

Feature 11 puts Pro→customer reviews **in the same table**, carrying the same
`proId` — because the Pro is the author. So the moment the first Pro rates a
customer 2 stars for `no_access`, that 2 is inside the `proId` group. At 02:00
the rebuild folds the Pro's _opinion of a customer_ into the Pro's _own public
rating_, and because the rebuild is the thing that corrects drift, it will
look authoritative. A Pro who is diligent about flagging difficult customers
would drive their own rating down.

**The fix is three lines and one test.** Both the drift query and the rebuild
get `WHERE "reviewerType" = 'customer'`, and a new CTE rebuilds
`Customer.ratingSum` / `ratingCount` from `WHERE "reviewerType" = 'pro'`. The
test inserts one review in each direction and asserts a rebuild leaves the Pro's
rating exactly where the customer's review put it.

This is worth writing down because it is the failure mode this codebase keeps
producing: a query that was correct when written, made wrong by a row that did
not exist yet. #56 was the same shape.

`ProCountersService` is in `src/modules/pros/` — **module 6's folder.** This is
a coordination event; see §13.

---

## 2 · Scope

### In

1. Four training tables, trade-derived curriculum, per-Pro progress with resume.
2. Server-graded quizzes with a capped, resettable retry policy.
3. An offline manifest so the app can pre-download on wifi.
4. Offline session scheduling, enrolment, attendance.
5. A mandatory-module gate on `ProService` activation — **shipped off**.
6. Customer→Pro reviews: rating, comment, photos, tags. The write path that
   makes the existing rating pipeline live.
7. Pro→customer reviews: rating + controlled tags, internal only.
8. `Customer.ratingSum` / `ratingCount`, rebuilt by the same nightly job.
9. A customer advisory on the next Pro's job card.
10. Moderation: hide content with a reason and a name.

### Out — and why

| Not building                            | Because                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ProQualityAudit`, any scored audit     | Removed from the product deliberately. Standing rests on customer rating alone                                                  |
| Any automatic action on a customer      | Feature 13 says Pro→customer "drives nothing". A household losing service with no explanation and no appeal is the failure mode |
| Editing a review                        | One row per booking per direction, immutable except moderation. Keeps `ratingSum` exact without a compensating-update path      |
| Free text in the Pro→customer direction | A controlled vocabulary is aggregable and cannot libel a customer. `comment` is rejected, not ignored                           |
| Video transcoding, CDN, DRM             | The file that was uploaded is the file that is served                                                                           |
| An offline sync engine                  | The backend publishes a manifest with sizes and versions. Caching is the app's job and always was                               |
| Certificates, badges, expiry            | No one has asked for a training that lapses                                                                                     |
| A `SupportTicket` of any kind           | Module 11. This module raises none, and must not invent a half of one                                                           |

---

## 3 · Data model

### 3.1 New — `src/modules/training`

```
TrainingModule
  id, categoryId → ServiceCategory, title, description
  contentType     video | doc | checklist | quiz
  contentKey      private S3 key            (platform-uploaded content)
  contentUrl      absolute URL, nullable    (externally hosted content)
  contentBytes    int?      — the app needs this to decide "wifi only"
  version         int @default(1) — bumped on content replace; the app's
                  cache-invalidation signal, and the reason a re-upload is
                  not silently invisible to a Pro who already downloaded it
  quizAnswerKey   Json?  ← NEVER serialised to a Pro. §6
  quizPassPercent int?   — per-module override of the platform default
  durationMinutes, isMandatory, sortOrder, isActive
  @@index([categoryId, sortOrder])

ProTrainingProgress
  id, proId, moduleId
  status              not_started | in_progress | completed
  percentComplete     int 0–100
  lastPositionSeconds int @default(0)  ← feature 3, "resumable"
  quizAttempts        int @default(0)
  quizScore           Decimal?  — the latest attempt
  bestQuizScore       Decimal?  — what the gate reads
  lockedAt            DateTime? — attempts exhausted; admin can clear
  startedAt, completedAt
  @@unique([proId, moduleId])

OfflineTrainingSession
  id, categoryId, title, venue, scheduledAt, durationMinutes,
  trainerName, capacity, status  scheduled | held | cancelled
  @@index([status, scheduledAt])

OfflineTrainingAttendance
  id, sessionId, proId, enrolledAt,
  attended Boolean @default(false), markedByAdminId, markedAt, completionNotes
  @@unique([sessionId, proId])   ← enrolling twice is a bug, not a second seat
```

Five fields beyond the ERD, each earning its place: `lastPositionSeconds`
(resume), `quizAttempts` + `lockedAt` (the retry cap), `bestQuizScore` (so a
worse retake cannot un-qualify someone), `contentBytes` + `version` (the offline
manifest is useless without them).

### 3.2 Altered — coordination event, one migration

```prisma
model Review {
  reviewerType String  @default("customer")   // customer | pro
  photoUrls    Json    @default("[]")
  hiddenByAdminId String?   @db.Uuid
  hiddenAt        DateTime?

- bookingId String @unique          // blocks the second direction entirely
+ @@unique([bookingId, reviewerType])
  @@index([customerId, createdAt])  // the advisory query in §9
}

model Customer {
+ ratingSum   Int @default(0)
+ ratingCount Int @default(0)
}
```

`@default("customer")` matters: the existing rows — there are none in
production, but the seed and every dev database — become customer reviews
without a backfill, which is what they are.

Dropping `@unique` on `bookingId` for a composite is the only destructive edit
in the migration. It is safe here precisely because nothing has ever written a
row.

---

## 4 · How a Pro's curriculum is derived

No enrolment table for online modules, no per-Pro assignment list. What a Pro
sees is a **query**, so adding a service to a Pro changes their curriculum the
same instant, and nothing can drift.

```
  Pro
   │
   │  ProService WHERE isActive = true
   ▼
  Service ──► categoryId ──► ServiceCategory
                                  │
                                  │ walk parentCategoryId upward
                                  ▼
                          [ Plumbing ▸ Drainage ]      ← the trade and its parent
                                  │
   TrainingModule WHERE categoryId IN (that set)
                     AND isActive = true
                                  │
                                  ▼
              LEFT JOIN ProTrainingProgress (proId, moduleId)
                                  │
                                  ▼
                    ordered by isMandatory DESC, sortOrder
```

The ancestor walk is the part worth stating: a module attached to **Plumbing**
reaches every Pro who does any plumbing service, and a module attached to
**Drainage** reaches only those. That is what "trade-level" means in a category
tree, and without the walk every safety module would have to be duplicated onto
every leaf.

Depth is bounded by the tree, which is two levels today. Resolved with one
recursive CTE, not N queries.

---

## 5 · The activation gate

Feature 6: a Pro cannot be activated for a service until the mandatory modules
for that service's trade are complete.

The decision point is `ProServiceAssignmentsService` — `assign()` (which creates
with `isActive: true`) and `update()` (which can flip it to true). Both are in
**module 6's folder**.

Same port/delegate pattern as the six already in this codebase — the consumer
owns the interface and a no-op, the provider registers itself at boot:

```
src/modules/pros/ports/training-gate.port.ts     ← module 6 owns it (new file)
    interface TrainingGatePort {
      assertEligible(proId, serviceId): Promise<void>   // throws 409 with the
    }                                                   // missing module list
    NoOpTrainingGate — allows everything, register()

src/modules/training/training-gate.adapter.ts    ← module 10 registers into it
```

**It ships off.** `training.gateActivation` defaults `false`, exactly as
`geo.enforceAreaServiceAvailability` does, and for the same reason: switching on
a gate before the content behind it exists blocks every Pro activation on the
platform and the cause is not obvious from the error. It is turned on when a
trade actually has its mandatory modules loaded — plausibly per city.

The 409 lists what is missing by title. "Not eligible" with no list is a support
ticket.

---

## 6 · Quizzes — why grading is server-side

Feature 4 says the score is the defensible signal, not percent watched. A score
the Pro's phone computed is not defensible.

```
  Pro app                              Server
     │  GET /pros/me/training/:id         │
     │  ─────────────────────────────────►│  serialises questions
     │                                    │  and options.
     │  ◄─────────────────────────────────│  quizAnswerKey is NOT in
     │      { questions: [...] }          │  the DTO. Ever.
     │                                    │
     │  POST .../quiz  { answers }        │
     │  ─────────────────────────────────►│  grade against quizAnswerKey
     │                                    │  score = correct / total × 100
     │  ◄─────────────────────────────────│  attempts += 1
     │   { score, passed, attemptsLeft }  │  bestQuizScore = max(...)
```

The answer key lives in a column that no DTO reads. One spec asserts that: it
serialises the module through the Pro-facing DTO and fails if the string
`quizAnswerKey` appears anywhere in the JSON.

Retry cap from `training.maxQuizAttempts` (default 3). On exhaustion `lockedAt`
is set, further submissions are 409, and an admin with `TRAINING_MANAGE` can
reset. A cap with no reset path is a Pro permanently unable to work.

Pass mark: module override, else `training.quizPassPercent` (default 70).

---

## 7 · Offline material — what the backend actually owes the app

Features 7 and 8 are client behaviour. The backend's whole contribution is one
endpoint that says what to download, how big it is, and whether the copy on the
phone is stale:

```json
GET /pros/me/training/manifest
{
  "generatedAt": "...",
  "modules": [
    { "moduleId": "...", "version": 3, "contentType": "video",
      "bytes": 48211004, "wifiRecommended": true,
      "url": "https://…s3…?X-Amz-Expires=21600", "urlExpiresAt": "..." }
  ]
}
```

`version` is the only correctness-critical field. Without it, replacing a video
leaves every Pro watching last month's procedure with no way to know.

**`createViewUrl` needs a TTL parameter.** It is hard-coded to 5 minutes, which
is right for a KYC document and wrong for a 48 MB video download on Indian
mobile data. Adding an optional second argument that defaults to the current
value changes no existing behaviour — but `src/storage/` is shared, so it is a
coordination event (§13). Training uses 6 hours.

Nothing here is confidential; the long TTL is a convenience risk, not a
disclosure one.

---

## 8 · Reviews — the asymmetry, stated in one table

|                | Customer → Pro                     | Pro → Customer                       |
| -------------- | ---------------------------------- | ------------------------------------ |
| `reviewerType` | `customer`                         | `pro`                                |
| Rating         | 1–5, required                      | 1–5, required                        |
| Comment        | Optional free text                 | **Rejected with 400.** Tags only     |
| Photos         | Up to `review.maxPhotos` (3)       | None                                 |
| Tags           | Controlled vocabulary              | Controlled vocabulary                |
| Visible to     | Everyone — public Pro profile      | **Ops and the next Pro only**        |
| Counters       | `Pro.ratingSum` / `ratingCount`    | `Customer.ratingSum` / `ratingCount` |
| Drives         | Dispatch tie-break (0.15), profile | **Nothing. Automatically, nothing**  |

Tag vocabularies are constants in code, validated with `@IsIn`, not free
strings — an unvalidated tag list is a free-text field with extra steps and
cannot be aggregated.

```ts
CUSTOMER_REVIEW_TAGS = [
  'punctual',
  'polite',
  'clean_work',
  'well_equipped',
  'explained_clearly',
  'late',
  'unprepared',
  'rushed',
];
PRO_REVIEW_TAGS = [
  'no_access',
  'unsafe',
  'pets_loose',
  'payment_difficulty',
  'pleasant',
]; // ← feature 11
```

Both directions: only on a `completed` booking, only by the actual participant,
only once, and only within `review.windowDays` (14). Existing `recordReview`
already enforces the first three — its logic moves into the new service rather
than being rewritten.

### The write path

```
  POST /bookings/:id/review                    (customer)
  POST /pros/me/bookings/:id/review            (pro)
            │
            ▼
   advisory lock  review:<bookingId>:<reviewerType>
            │
            ├─ booking completed?  participant matches?  inside window?
            ├─ existing row? → return it, 200. Not an error; a double-tap
            │
            ├─ INSERT review
            └─ INCREMENT the counter on the OTHER party
                        Pro.ratingSum        (customer → pro)
                        Customer.ratingSum   (pro → customer)
```

Both in one transaction, so the counter and the row cannot disagree — and the
nightly rebuild proves they didn't.

---

## 9 · The customer advisory

Feature 13: prior Pro-authored ratings appear on the next Pro's job card, and
never to the customer.

```
GET /pros/me/bookings/:id/customer-advisory
{
  "ratingAverage": 2.7, "ratingCount": 6,
  "tagCounts": { "no_access": 3, "pets_loose": 1 },
  "recentNotes": [ { "occurredAt": "...", "tags": ["no_access"] } ]
}
```

Aggregated and tag-only. No prior Pro is named, no free text exists to leak, and
a Pro walking into a house learns "three people could not get in" rather than
who said it.

**The leak this module has to actively prevent** is a `reviewerType = 'pro'` row
appearing on a customer-facing route. Every customer-facing review query filters
`reviewerType: 'customer'`, and one e2e test walks the real HTTP surface for
each customer route that returns reviews and fails if a `pro` row appears. A
`WHERE` clause someone can forget is not a privacy boundary; a test is.

---

## 10 · Moderation

`POST /admin/reviews/:id/hide  { reason }` → `isHidden`, `hiddenReason`,
`hiddenByAdminId`, `hiddenAt`. Unhide reverses it and keeps the trail.

**Hiding removes the content, never the score.** A one-star review with an
abusive sentence is still a one-star experience; deleting the rating would let
moderation quietly launder a Pro's average, and it would mean the nightly
rebuild — which counts rows — permanently disagrees with the live counter.
`ProStandingService.ratings()` already implements exactly this rule, which is
the precedent.

Photos are hidden as a unit with the text. Splitting them is a second decision
for a case no one has had.

---

## 11 · Endpoints — 24

### Pro · training (6)

| Method | Path                                   | Notes                                                     |
| ------ | -------------------------------------- | --------------------------------------------------------- |
| GET    | `/pros/me/training`                    | Curriculum + progress. `?serviceId=` for in-job reference |
| GET    | `/pros/me/training/manifest`           | Offline bundle, §7                                        |
| GET    | `/pros/me/training/:moduleId`          | Content URL, resume position, quiz questions              |
| PATCH  | `/pros/me/training/:moduleId/progress` | `percentComplete`, `lastPositionSeconds`                  |
| POST   | `/pros/me/training/:moduleId/quiz`     | Graded server-side, §6                                    |
| GET    | `/pros/me/training/sessions`           | My offline sessions, upcoming and attended                |

### Admin · training (9)

| Method         | Path                                                 |
| -------------- | ---------------------------------------------------- |
| GET            | `/admin/training/modules`                            |
| POST           | `/admin/training/modules`                            |
| PATCH          | `/admin/training/modules/:id`                        |
| POST           | `/admin/training/modules/upload-url`                 |
| GET            | `/admin/training/pros/:proId`                        |
| POST           | `/admin/training/pros/:proId/modules/:id/reset-quiz` |
| GET·POST·PATCH | `/admin/training/sessions[/:id]`                     |
| POST           | `/admin/training/sessions/:id/enrolments`            |
| POST           | `/admin/training/sessions/:id/attendance`            |

### Reviews (9)

| Method | Path                                      | Actor    |
| ------ | ----------------------------------------- | -------- |
| POST   | `/bookings/:id/review`                    | Customer |
| POST   | `/bookings/:id/review/photos/upload-url`  | Customer |
| GET    | `/bookings/:id/review`                    | Customer |
| GET    | `/pros/:proId/reviews`                    | Public   |
| POST   | `/pros/me/bookings/:id/review`            | Pro      |
| GET    | `/pros/me/bookings/:id/customer-advisory` | Pro      |
| GET    | `/admin/reviews`                          | Admin    |
| POST   | `/admin/reviews/:id/hide` · `/unhide`     | Admin    |
| GET    | `/admin/customers/:id/feedback`           | Admin    |

Two route-collision checks, because #56 cost a boot:

- `/pros/me/training/*` — no existing controller claims it. `pros/me` is served
  by three controllers already (`pros`, `pro-earnings`, `pro-payments`); a
  fourth is fine, distinct segments.
- **`/pros/:proId/reviews` is why there is deliberately no `/pros/me/reviews`.**
  Fastify would bind `me` to `:proId`. The Pro's own review list is
  `/pros/me/ratings`, which already exists.

`test/http-routes.e2e-spec.ts` catches both if I am wrong.

---

## 12 · Permissions and settings

Two codes, not six. Module 8 needed four because money moved; nothing here does.

```ts
TRAINING_MANAGE: 'training.manage',   // content, sessions, attendance, resets
REVIEW_MODERATE: 'review.moderate',   // hide, unhide, read the feedback view
```

Reading training progress rides on `PRO_MODERATE`, which ops already holds.

| Setting                    | Default | Effect                                      |
| -------------------------- | ------- | ------------------------------------------- |
| `training.gateActivation`  | `false` | Enforce mandatory modules before activation |
| `training.maxQuizAttempts` | `3`     | Then `lockedAt`, until an admin resets      |
| `training.quizPassPercent` | `70`    | Module-level override wins                  |
| `review.windowDays`        | `14`    | After this, both directions are closed      |
| `review.maxPhotos`         | `3`     | Customer direction only                     |

---

## 13 · Coordination events — for the teammate, each its own commit

Four, and one of them is load-bearing.

1. **`prisma/schema.prisma` + migration** — 4 new tables, `Review` altered,
   `Customer` altered. Includes dropping `Review.bookingId @unique`.
2. **`src/modules/pros/pro-counters.service.ts`** — the `reviewerType` filter of
   §1, plus the customer-counter CTE. **This one is not optional and not
   cosmetic**; shipping the schema without it corrupts Pro ratings on the first
   nightly run after the first Pro→customer review.
3. **`src/modules/pros/ports/training-gate.port.ts`** (new) and the two call
   sites in `pro-service-assignments.service.ts`.
4. **`src/storage/s3.service.ts`** — optional TTL argument on `createViewUrl`,
   defaulting to today's 5 minutes.

Plus the usual: `app.module.ts` registration, `permission-code.ts`,
`swagger.config.ts` tags.

**And one thing to delete, which is theirs to delete:**
`ProCountersService.recordReview` becomes genuinely dead once this module owns
review writing. Two implementations of the same rule, one unreachable, is how
#56 happened. Flagging it, not removing it.

---

## 14 · Order of work

| #   | Step                                                        | Why here                                                    |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Schema + migration + the `reviewerType` rebuild fix         | The hazard lands with the column that creates it, not after |
| 2   | `src/modules/reviews` — both directions, counters, advisory | Unblocks feature 15, which is otherwise 90% built and idle  |
| 3   | Moderation + admin read surfaces                            | Small, and reviews are public the moment step 2 ships       |
| 4   | `src/modules/training` — modules, curriculum, progress      | Independent of everything above                             |
| 5   | Quizzes, then the manifest                                  | The manifest needs `version`, which quizzes do not          |
| 6   | The gate port, off                                          | Last, so nothing is blocked while content is still empty    |
| 7   | Offline sessions and attendance                             | Genuinely standalone; the only step safe to defer           |

Steps 2 and 4 do not depend on each other and could run in parallel across the
two developers.

**Two folders, not one.** `src/modules/reviews` is read by ops and public
surfaces; `src/modules/training` is a leaf nothing imports except the gate port.
Sharing a folder would only mean sharing a module file.

---

## 15 · The open question I am not answering

> "What ops actually does about a badly-rated customer — warn, force online
> payment, block — is undefined. Collecting unsafe tags and acting on none of
> them is worse than not collecting them."

That is a policy decision and it is correctly identified as unresolved. What
this plan does is make it _actionable_ rather than pre-empting it:

- `GET /admin/customers/:id/feedback` puts the pattern in front of ops — six
  jobs, three `no_access`, average 2.7.
- `Customer.isBlocked` and `CUSTOMER_MODERATE` **already exist**, built in
  module 2. Ops can act today; they just cannot currently see why they should.
- The formal path — a `quality` ticket with `actionTaken` — is module 11, and
  this module deliberately does not build a fragment of it.

What is **not** built is any automatic consequence. Feature 13 is explicit that
the Pro→customer direction drives nothing, and the reason is worth keeping in
front of whoever revisits this: a household quietly losing service, with no
notice and no appeal, from a signal it cannot see, is a worse outcome than a
Pro occasionally walking into a difficult job forewarned.

The gap between "collected" and "acted on" narrows to one screen and one
existing button. Closing it fully needs a policy, not more code.

---

## 16 · What shipped, and where it differs from the plan

Built 2026-08-12. **918 unit tests / 67 suites, 181 e2e / 8 suites**, typecheck
and lint clean, 224 routes mapped, application boots.

### 16.1 · Verified against the real database, not only mocked

Two things here could not be proven by a unit test, so they were run against
Postgres directly, each inside a transaction that rolls back.

**#61 — the reviewer direction.** One booking, two reviews, then the exact
rebuild statements the nightly job runs:

```
                     shipped (filtered)   what unfiltered would have produced
Pro   ratingSum/Count      5 / 1                       7 / 2
Pro   average               5.0                         3.5
Customer ratingSum/Count   2 / 1                       0 / 0
```

**The eight new CHECK constraints**, each in its own PL/pgSQL block with an
exception handler — the subtransaction is what stops a failed statement
poisoning the next trial and turning a failure into a false pass, which is the
trap module 9's immutability test fell into:

| Constraint                              | Result |
| --------------------------------------- | ------ |
| Pro-direction review rejects a comment  | PASS   |
| One booking holds both directions       | PASS   |
| Same direction twice is refused         | PASS   |
| Hiding requires a reason and a time     | PASS   |
| A quiz needs an answer key              | PASS   |
| A module has exactly one content source | PASS   |
| Completed progress needs `completedAt`  | PASS   |
| One seat per Pro per session            | PASS   |

### 16.2 · Departures from the plan

| #   | Planned                                                      | Shipped                                                      | Why                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 24 endpoints                                                 | **29**                                                       | The plan's table collapsed `GET/POST/PATCH /sessions[/:id]` into one row, and two `GET …/review` reads were implied rather than listed                                                                                                                                                                                                                                      |
| 2   | The `Review` unique swap and nothing else on existing tables | Also **`Booking.review` → `Booking.reviews`**                | A `Review?` back-relation is a one-to-one and Prisma refuses it against a composite key. It is what made departure 3 visible                                                                                                                                                                                                                                                |
| 3   | Two places needed the `reviewerType` filter                  | **Three.** `incentive-evaluation.service.ts` too             | A rating incentive reads a booking's review. Unfiltered, a Pro reaches a five-star bonus by rating their own customers five stars. Only surfaced because departure 2 broke the compile — added to #61                                                                                                                                                                       |
| 4   | Leave `ProCountersService.recordReview` alone                | **Repaired, still deprecated**                               | It stopped compiling against the composite key. Two lines to fix, versus deleting from module 6's folder unilaterally. Marked `@deprecated` with a pointer at its replacement                                                                                                                                                                                               |
| 5   | A `contentType === 'video'` branch in `assertContent`        | Removed                                                      | It was a no-op left over from an earlier shape                                                                                                                                                                                                                                                                                                                              |
| 6   | —                                                            | Two DTO bugs of my own, found by testing rather than reading | `MarkAttendanceDto.entries` used `@IsObject({ each: true })`, which checks an element is an object and descends no further — a `proId` of "yes" would have reached Prisma. And `UpdateTrainingModuleDto` re-declared three fields with `declare`, whose decorator semantics are a compiler-internals question; replaced with `PartialType`, the idiom module 2 already uses |
| 7   | —                                                            | A **negative** assertion on the old SQL                      | `expect(sql).not.toMatch(/FROM "reviews" GROUP BY "proId"/)`. Asserting the fix is present does not fail if somebody adds a second unfiltered CTE beside it                                                                                                                                                                                                                 |

### 16.3 · What is enforced, and by what

| Rule                                     | Database                              | Service                                                | Test                    |
| ---------------------------------------- | ------------------------------------- | ------------------------------------------------------ | ----------------------- |
| A booking holds one review per direction | `@@unique([bookingId, reviewerType])` | Advisory lock, returns the existing row                | ✅ both                 |
| The Pro direction carries no prose       | CHECK                                 | DTO has no `comment` field; the global pipe rejects it | ✅ both                 |
| A counter moves on the _other_ party     | —                                     | One transaction with the insert                        | ✅ unit                 |
| The nightly rebuild respects direction   | —                                     | Three filtered queries                                 | ✅ SQL-shape + live run |
| The quiz answer key never reaches a Pro  | —                                     | Absent from the DTO                                    | ✅ serialise-and-search |
| A quiz cannot exist ungradeable          | CHECK                                 | 400 with a field name                                  | ✅ both                 |
| Moderation carries a reason and a name   | CHECK                                 | Required in the DTO                                    | ✅ live run             |
| A retry cap that can be undone           | —                                     | `lockedAt` + admin reset                               | ✅ unit                 |

### 16.4 · The one thing the tests do not cover

**A request-level privacy test.** The plan called for an e2e test that walks
every customer-facing route and fails if a `reviewerType: 'pro'` row appears in
a response. There is no DB-backed HTTP suite in this repo to hang it on — the
existing e2e suites stub Prisma entirely, and the real-request checks are the
manual curl scripts in `test/manual/`.

What is covered instead, and what it is worth:

- `publicForPro` is asserted to pass `reviewerType: 'customer'` to **all three**
  of its queries — `findMany`, `count` and `groupBy`. A filter on the list but
  not the count is the realistic mistake, and it would leak through the
  summary.
- `forBooking` refuses to hand one party the other's row.
- The advisory lives on a `@RequireActorType('pro')` controller, and there is
  no customer-facing route that reads it.

That is three unit assertions and a guard where the plan asked for one
end-to-end proof. Stated plainly rather than quietly downgraded: **a `WHERE`
clause someone can forget is not a privacy boundary**, and the boundary here is
currently held by convention plus per-query tests. A DB-backed HTTP suite is
worth building before module 11 puts support tickets on the same table.

### 16.5 · Still open

- **`training.gateActivation` is off**, as designed. It stays off until a trade
  has its mandatory modules loaded. Nothing about the mechanism is untested —
  the gate registers at boot and the log line says so — but no deployment has
  yet run with it on.
- **`ProCountersService.recordReview` is dead** and now duplicates a rule module
  10 owns. It is module 6's to delete.
- **No training content exists.** Every curriculum in the system is currently
  empty, which is the correct state and also means the Pro-facing screens have
  not been exercised against real data.
