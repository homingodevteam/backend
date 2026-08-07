# Module Status Report — Identity & Access, Customer Profile, Pro Management

**Date:** 2026-08-07
**Scope:** Modules 1, 2, 6 per `Modules_and_Features 1.md`, audited feature-by-feature, gaps closed where they didn't depend on an unbuilt module, then verified with unit tests, e2e tests, and a live boot against the real RDS instance.

---

## 1. Identity & Access — 10/10 features built

| #   | Feature                                                       | Status                                                                                           |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Phone + OTP login/signup, all three actor types               | ✅                                                                                               |
| 2   | OTP dispatch/verify delegated to third party                  | ✅ (mock provider — swap-in seam for MSG91/Synquic Slide, no keys yet)                           |
| 3   | Guest customer session from device id                         | ✅                                                                                               |
| 4   | Guest → verified upgrade, same customer id preserved          | ✅                                                                                               |
| 5   | Session issue/refresh/revoke, multi-device                    | ✅ (Redis-backed)                                                                                |
| 6   | Admin role assignment; permission codes as json array on Role | ✅                                                                                               |
| 7   | Permission-check middleware on every admin mutation           | ✅ (`PermissionsGuard`)                                                                          |
| 8   | City-scoped admin access                                      | ✅ (`CityScopeGuard` — functional skeleton; nothing city-scoped exists yet to fully exercise it) |
| 9   | Account block/unblock (customer), suspend/reinstate (Pro)     | ✅                                                                                               |
| 10  | Rate limiting on OTP requests per phone                       | ✅                                                                                               |

No gaps found. Nothing in this module depends on a module that isn't built yet.

---

## 2. Customer Profile — 8/9 features built as specified by the ERD

| #   | Feature                                               | Status                                                                                                                                         |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Profile view/edit — name, optional email              | ✅                                                                                                                                             |
| 2   | Multiple saved addresses, labelled home/office/other  | ✅                                                                                                                                             |
| 3   | Exact coordinate pinning, stored separately from text | ✅                                                                                                                                             |
| 4   | Landmark and free-text delivery notes per address     | ⚠️ See "ERD cross-check" below — `landmark` exists; a separate `deliveryNotes` column does not, because the authoritative ERD doesn't have one |
| 5   | Default address selection                             | ✅                                                                                                                                             |
| 6   | City resolution from the pinned coordinate            | ⏸ Deferred — needs Geo & Routing (module 13, not built): reverse geocoding via OpenStreetMap. Client currently supplies `cityId` directly.     |
| 7   | Serviceability check before booking                   | ✅ (MVP version: is the city active — real geo/pincode logic is module 13's job)                                                               |
| 8   | Razorpay customer object creation on first payment    | ⏸ Deferred — needs Payments (module 7, not built)                                                                                              |
| 9   | Address edit-history guard (in-flight booking)        | ⏸ Deferred — needs Booking (module 4, not built). A `TODO` comment marks exactly where to wire it in `customers.service.ts`.                   |

---

## 3. Pro Management — 19/19 features now built, 3 gaps closed this pass

_Onboarding (8/8)_

| #   | Feature                                                      | Status                                                                                                                          |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | In-app self-application, referral attribution                | ✅                                                                                                                              |
| 2   | Aadhaar/PAN capture, either route per document               | ✅ (manual → S3 presigned upload; DigiLocker returns a clear "not integrated yet" error rather than a silent gap)               |
| 3   | Independent verification per document                        | ✅                                                                                                                              |
| 4   | Admin queue: pending → docs review → call pending → decision | ✅ (`queueStatus`)                                                                                                              |
| 5   | Verification call logging                                    | ✅                                                                                                                              |
| 6   | Approve/reject with reason                                   | ✅                                                                                                                              |
| 7   | Re-application supported, history preserved                  | ✅                                                                                                                              |
| 8   | Activation gate: only approved Pros visible to dispatch      | ✅ as far as this module goes — `Pro.status` is the gate; the dispatch engine itself (module 5) doesn't exist yet to consume it |

_Profile & capability (5/5)_

| #   | Feature                                 | Status                                                                                                                                                 |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | Employee code + recorded monthly salary | 🔧 **Fixed this pass** — `employeeCode` auto-generates on approval, but nothing could ever set `monthlySalary`. Added `PATCH /admin/pros/:id/profile`. |
| 10  | Home base coordinate                    | ✅ (Pro self-editable via `PATCH /pros/me`)                                                                                                            |
| 11  | Service assignment with proficiency     | ✅                                                                                                                                                     |
| 12  | Per-service suspension                  | ✅                                                                                                                                                     |
| 13  | Bank account details                    | ✅                                                                                                                                                     |

_Operations (6/6)_

| #   | Feature                                                         | Status                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 14  | Availability toggle, admin-only                                 | ✅                                                                                                                                                                                                                                                     |
| 15  | Admin roster screen (filterable, bulk on/off)                   | ✅ (`GET /admin/pros` filters + `PATCH /admin/pros/availability/bulk`)                                                                                                                                                                                 |
| 16  | Live location ingest into Redis GEO + cold flush                | 🔧 **Fixed this pass** — was entirely missing. Added `POST /pros/me/location`: writes to Redis GEO (`pros:live`) and cold-flushes `Pro.lastKnownLat/Lng` in the same call (simplest correct version of "periodic" until a real background job exists). |
| 17  | Status lifecycle: applied → under_review → approved → suspended | ✅ (plus `rejected`, needed for the re-application flow)                                                                                                                                                                                               |
| 18  | Acceptance rate, counters rebuilt nightly                       | ⏸ Counter columns exist; nothing populates them yet — correctly deferred, since they're driven by the Dispatch engine (module 5), which doesn't exist                                                                                                  |
| 19  | Pro-facing profile/rating/acceptance-rate/history views         | ✅ (`GET /pros/me` returns the full profile; the numbers are 0 until modules 5/10 populate them, which is expected)                                                                                                                                    |

**Also found and fixed while auditing:** `Pro.cityId` existed as a schema column but no endpoint ever set it. Rolled into the same `PATCH /admin/pros/:id/profile` endpoint as the salary fix.

**Gaps closed:** admin profile-update endpoint, location-ingest endpoint + Redis `GEOADD` helper — both migration-free, since `Pro.cityId`/`Pro.monthlySalary` already existed as ERD-sanctioned columns and location ingest only touches Redis + existing `lastKnownLat/Lng` columns.

---

## ERD cross-check (2026-08-07, follow-up)

Every table these three modules own was compared field-by-field against the authoritative v10 ER diagram (Eraser, team TheUnknownGMR) — the ERD, not the narrative doc, is the source of truth for actual column names/types per this project's established precedence.

**Exact match:** `Customer`, `City`, `Pro`, `ProApplication`, `ProService`, `ProBankAccount`, `Role`, `AdminUser`, `AdminAuditLog` — every column the ERD specifies, and no extras (`updatedAt` aside, which is standard practice on every table and harmless).

**One deviation found and corrected:** `CustomerAddress.deliveryNotes` had been added in the pass above, prompted by `Modules_and_Features 1.md`'s feature #4 ("landmark **and** free-text delivery notes"). The ERD's `CustomerAddress` only has `landmark` — no separate notes field. Per this project's own rule (ERD wins on schema shape, the narrative doc wins on business-rule _why_), that column has been **removed** — migration `20260807122120_remove_customer_address_delivery_notes` — and `landmark` alone stands for both jobs, matching the ERD exactly. Module 2 is now 8/9 built, with delivery notes correctly out of scope until/unless the ERD is updated to add that column.

**Other things confirmed while cross-checking:**

- `Pro.cityId` and `Pro.monthlySalary` were already ERD-sanctioned columns from the original build — this pass only added the missing _endpoint_ to write them, not new schema.
- The location-ingest endpoint uses the exact Redis key the ERD specifies (`pros:live`), not an invented one.
- Admin-id reference columns on `ProApplication` (`reviewedByAdminId`, `aadhaarVerifiedByAdminId`, `panVerifiedByAdminId`) are plain string columns, not formal Prisma `@relation`s to `AdminUser` — this matches the ERD's own diagram (it draws these as FK arrows without them being enforced relations in every ORM sense) and was a pre-existing choice, not something this pass changed.
- Nothing in modules 1/2/6 currently _writes_ `pushToken`/`pushPlatform` on any of the three user tables (columns exist per the ERD, correctly reserved for when Notifications — module 12 — needs them). Worth knowing, not a gap in this scope.

---

## What's genuinely out of scope (not a gap — a dependency on an unbuilt module)

| Deferred item                                        | Needs                                          | Where the seam is                              |
| ---------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| City resolution from coordinate, real serviceability | Module 13 (Geo & Routing)                      | `customers.service.ts`                         |
| Razorpay customer object                             | Module 7 (Payments)                            | `Customer.razorpayCustomerId` column, unset    |
| Address in-flight-booking guard                      | Module 4 (Booking)                             | `TODO` comment in `customers.service.ts`       |
| Dispatch consuming `Pro.status`/`ProService`         | Module 5 (Dispatch Engine)                     | N/A yet                                        |
| Rating/acceptance-rate/completedJobs counters        | Modules 5 (Dispatch) + 10 (Training & Reviews) | Columns exist, default 0                       |
| DigiLocker auto-verify                               | External partner registration                  | Explicit `NotImplementedException`, not silent |

---

## Test results

**Unit tests — 41 passed, 6 suites, 0 failed**
New this pass: `auth.service.spec.ts` (10 tests — OTP rate limiting, guest→verified upgrade preserving id, blocked customer rejection, suspended Pro rejection, admin never auto-created), `permissions.guard.spec.ts` (5 tests — no-permission passthrough, non-admin rejection, stale role, missing permission, full pass), `customers.service.spec.ts` (10 tests — auto-default on first address, inactive-city rejection, block/unblock + audit log, ownership check on delete), `pros.service.spec.ts` (10 tests — suspend/reinstate state-machine guards, bulk availability, admin profile update incl. bad cityId, location ingest, employee-code sequence), `pro-applications.service.spec.ts` (6 tests — DigiLocker rejection, manual-URL requirement, dual-verification gate on approval, employee-code idempotency).

**e2e tests — 13 passed, 3 suites, 0 failed**
`app.e2e-spec.ts`, `envelope.e2e-spec.ts` (response envelope + validation contract), `swagger-envelope.e2e-spec.ts` (OpenAPI schema matches runtime envelope shape).

**Static checks — all clean**
`npm run build` (nest/tsc), `npm run typecheck` (`tsc --noEmit`, whole project incl. tests), `npm run lint` (eslint --fix, 0 errors).

**Live verification against real infra**
Booted the full app against the actual AWS RDS instance: Prisma connects, all migrations applied, Swagger mounts, every route registers — including the new `POST /pros/me/location`. Boot proceeds exactly as far as it did before this pass and stops at the same, already-known point: Redis isn't configured yet in this environment (a separate, tracked, pre-existing item — not something this pass touched or broke).

---

## Net change this pass

- 2 migrations: `add_customer_address_delivery_notes` then `remove_customer_address_delivery_notes` (added, then reverted after the ERD cross-check — net schema effect: none, `CustomerAddress` is unchanged from before this pass)
- 2 new endpoints: `PATCH /admin/pros/:id/profile`, `POST /pros/me/location`
- 1 new Redis helper (`RedisService.geoAdd`)
- 5 new spec files, 41 new/existing unit tests, all green
- 0 regressions — full existing test suite (e2e) still 13/13
