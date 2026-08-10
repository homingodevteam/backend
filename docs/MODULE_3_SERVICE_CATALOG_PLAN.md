# Module 3 — Service Catalog · Implementation Plan

**Date:** 2026-08-10
**Branch target:** `homingo-backend-m1` (or a fresh `homingo-backend-m3`)
**Status of this document:** plan only — no code in this module has been written yet.

Written against [`Modules_and_Features 1.md`](Modules_and_Features%201.md) §3, the
ground-rules table that supersedes it, the US-3.x stories in
[`user-stories-by-persona/`](user-stories-by-persona/), and the shipped state of
modules 1, 2 and 6 as verified in
[`reports/FINAL_VERIFICATION_REPORT_2026-08-08.md`](reports/FINAL_VERIFICATION_REPORT_2026-08-08.md).

> **ERD note.** The authoritative v10 ER diagram lives in Eraser (team
> TheUnknownGMR). The Eraser MCP connector is **not authorized in this
> workspace**, so this plan is derived from `prisma/schema.prisma` plus the two
> narrative docs. Every column proposed in §3 must be diffed against the live
> ERD before the migration is written — per this project's established
> precedence, **the ERD wins on schema shape**, the narrative doc wins on the
> business-rule _why_. That cross-check is Step 0 of Phase A.

---

## 1 · Where the code stands today

| Thing                        | State                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/modules/catalog/`       | **77-line placeholder.** `GET /cities` only. Its own docblock says "Placeholder for the real Service Catalog module (module 3)."           |
| `City`                       | Built — `name`, `state`, `timezone`, `isActive`. Read-only via API; **no admin CRUD exists**, so no city can be created through the API.   |
| `ServiceCategory`, `Service` | **Do not exist.** Confirmed absent from `prisma/schema.prisma`.                                                                            |
| `ProService.serviceId`       | Bare `String`, no FK, no `@db.Uuid`. The schema comment at [schema.prisma:313](../prisma/schema.prisma#L313) says the catalog isn't built. |
| `Booking.serviceId`          | Same — bare `String` at [schema.prisma:371](../prisma/schema.prisma#L371).                                                                 |
| Validation of `serviceId`    | **None.** [`pro-service-assignments.service.ts:16`](../src/modules/pros/pro-service-assignments.service.ts#L16) accepts any string.        |

So module 3 is not a greenfield build — it is a greenfield build **plus** the
closing of two deliberately-dangling foreign keys that modules 4, 5, 6 and 8 all
depend on.

---

## 2 · Three contradictions to settle before writing code

These are genuine conflicts in the source documents, not ambiguities I can
resolve by picking a sensible default. My recommendation is given for each;
**#1 in particular changes what gets built.**

### 2.1 Duration → "tier selection in Commission" is dead

Module 3 feature #7 reads:

> Duration feeds two downstream systems: slot sizing in Dispatch and **tier
> selection in Commission**

But the ground-rules table — which states outright that it supersedes the scope
document wherever they conflict — says:

> **Commission rate.** One rate per Service (`commissionType`, `commissionValue`).
> No tiers, no duration bands, no per-city config. **Duration no longer changes
> what a Pro earns.**

Module 8 and US-3.10 agree with the ground rule. Feature #7 is a leftover from
the era when `CommissionTier` existed as a table.

**Recommendation:** ground rule wins. `expectedDurationMinutes` feeds **Dispatch
slot sizing and ETA only**. There is no tier table and no duration band. Feature
#7 is therefore half-scope, and the plan below builds only the surviving half.

### 2.2 "Per-city activation" means cities, not services

Feature #5 — "City registry with timezone; **per-city activation**" — reads at a
glance like per-city service availability. It is not:

- the module map gives module 3 exactly three tables — `ServiceCategory`,
  `Service`, `City`. There is no `ServiceCity` join;
- **Pricing:** "One flat price per service, nationally";
- **Geography:** "City-level only. No micromarkets or zones";
- US-3.4: "**One flat national price.** No city pricing exists in the model."

**Recommendation:** "per-city activation" = `City.isActive`. Every active
service is bookable in every active city. Serviceability is a city question,
which is exactly how module 2 already implements it.

### 2.3 Catalog edits are "audited" — but there is no audit table

US-3.5 and US-3.10 both say catalog changes are audited. `AdminAuditLog` was
**explicitly deferred and removed** (migration `20260808230000_defer_admin_audit_log`).

**Recommendation:** build the write path with the admin actor id threaded
through the service layer to the seam where audit will land, and record the gap
in the status report rather than inventing a table module 15 hasn't specified.
`updatedByAdminId` on `Service`/`ServiceCategory` is a cheap partial answer
worth taking now — it survives whatever module 15 decides.

---

## 3 · Schema

Two new models, plus type-tightening on two existing columns.

### 3.1 `ServiceCategory`

```prisma
model ServiceCategory {
  id        String   @id @default(uuid()) @db.Uuid
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  name         String
  slug         String  @unique
  description  String?
  iconUrl      String?
  displayOrder Int     @default(0)
  isActive     Boolean @default(true)

  parentId String?          @db.Uuid
  parent   ServiceCategory? @relation("CategoryTree", fields: [parentId], references: [id], onDelete: Restrict)
  children ServiceCategory[] @relation("CategoryTree")

  updatedByAdminId String?    @db.Uuid
  updatedByAdmin   AdminUser? @relation("CategoryEditor", fields: [updatedByAdminId], references: [id], onDelete: SetNull)

  services Service[]

  @@index([parentId, displayOrder])
  @@index([isActive])
  @@map("service_categories")
}
```

`onDelete: Restrict` on the self-relation and on `Service.category` is what
satisfies US-3.8's "**services must not be orphaned by a category deletion**" —
the database refuses, rather than the application remembering to check.

### 3.2 `Service`

```prisma
model Service {
  id        String   @id @default(uuid()) @db.Uuid
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  categoryId String          @db.Uuid
  category   ServiceCategory @relation(fields: [categoryId], references: [id], onDelete: Restrict)

  name         String
  slug         String  @unique
  description  String?
  iconUrl      String?
  displayOrder Int     @default(0)

  /// Drives Dispatch slot sizing and ETA. Deliberately NOT a commission input.
  expectedDurationMinutes Int
  /// One flat national price. Snapshotted onto Booking at creation.
  price                   Decimal @db.Decimal(12, 2)

  allowsInstant   Boolean @default(true)
  allowsScheduled Boolean @default(true)
  allowsRecurring Boolean @default(false)
  /// Ground rule "Cash": pay-after-service where the service and city allow it.
  allowsCash      Boolean @default(true)

  /// Nullable so a service can exist as a draft; activation is gated on both
  /// being set — see US-3.11.
  commissionType  String?
  commissionValue Decimal? @db.Decimal(12, 2)

  /// Draft by default. Activation is an explicit, validated transition.
  isActive Boolean @default(false)

  updatedByAdminId String?    @db.Uuid
  updatedByAdmin   AdminUser? @relation("ServiceEditor", fields: [updatedByAdminId], references: [id], onDelete: SetNull)

  proServices ProService[]
  bookings    Booking[]

  @@index([categoryId, displayOrder])
  @@index([isActive])
  @@map("services")
}
```

Design notes worth defending in review:

- **`isActive` defaults to `false`.** US-3.11 wants activating a service without
  a commission rate to be _blocked_; the cheapest way to guarantee that is to
  make "live" an explicit transition rather than the creation default.
- **`Decimal(12, 2)`** matches every existing money column
  (`BookingCommission`, `CommissionPayout`, `Pro.monthlySalary`). Note the
  existing, already-verified behaviour: Prisma serialises `Decimal` as a
  **string** in JSON, so `price` will come back as `"499.00"` — the same thing
  `monthlySalary` already does. The frontend contract must say so.
- **Booking-type flags as three booleans**, not an enum array — they are three
  independent switches, they index cleanly for the browse query, and the naming
  matches the ground rule's own `Service.allowsCash`.
- **`commissionType` as `String?`** rather than a Prisma enum, matching the
  existing convention in this schema (`Pro.status`, `Booking.status`,
  `BookingCommission.commissionType` are all plain strings). Validate the
  `percent | flat` domain in the DTO.

### 3.3 Closing the two dangling FKs

```prisma
// ProService
serviceId String  @db.Uuid
service   Service @relation(fields: [serviceId], references: [id], onDelete: Restrict)

// Booking
serviceId String  @db.Uuid
service   Service @relation(fields: [serviceId], references: [id], onDelete: Restrict)
```

**This is the riskiest step in the whole module** and needs its own commit.
`String → uuid` plus a new FK constraint fails outright on any existing row
whose `serviceId` is not a valid uuid or does not match a `services.id`.

Before writing the migration, run against every environment that matters:

```sql
SELECT count(*) FROM pro_services;
SELECT count(*) FROM bookings;
-- and, if non-zero:
SELECT DISTINCT "serviceId" FROM pro_services;
```

- **Both empty** (expected — module 4 isn't built and Pro service assignment
  has only been exercised in curl tests): the migration is a clean
  `ALTER TABLE … TYPE uuid USING "serviceId"::uuid` plus `ADD CONSTRAINT`.
- **Non-empty:** seed the real catalog first, map the old strings to new ids in
  the migration body, then alter. Do not let Prisma generate this one unassisted.

---

## 4 · API surface

Read paths are public (the customer app browses before login — module 1 already
supports guest sessions). Write paths are admin-only behind the existing
`JwtAuthGuard` + `PermissionsGuard`.

### 4.1 Customer / public

| Method | Route                              | Notes                                                                                              |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET`  | `/catalog/categories`              | Active tree, nested, `displayOrder` then `name`. Feature 1 + 6.                                    |
| `GET`  | `/catalog/categories/:id/services` | Active services in a category.                                                                     |
| `GET`  | `/catalog/services`                | Flat list. Filters: `categoryId`, `q`, `bookingType=instant\|scheduled\|recurring`. Feature 6.     |
| `GET`  | `/catalog/services/:id`            | **Resolves inactive services too** — US-3.1's edge: historical bookings must still render a name.  |
| `GET`  | `/cities`                          | **Already exists.** Keep the path — it is live and curl-verified. Do not move it under `/catalog`. |

### 4.2 Admin

| Method  | Route                                      | Permission                        |
| ------- | ------------------------------------------ | --------------------------------- |
| `POST`  | `/admin/catalog/categories`                | `catalog.manage`                  |
| `PATCH` | `/admin/catalog/categories/:id`            | `catalog.manage`                  |
| `PATCH` | `/admin/catalog/categories/:id/activation` | `catalog.manage`                  |
| `GET`   | `/admin/catalog/categories`                | `catalog.manage` (incl. inactive) |
| `POST`  | `/admin/catalog/services`                  | `catalog.manage`                  |
| `PATCH` | `/admin/catalog/services/:id`              | `catalog.manage`                  |
| `PATCH` | `/admin/catalog/services/:id/commission`   | `catalog.commission.set`          |
| `PATCH` | `/admin/catalog/services/:id/activation`   | `catalog.manage`                  |
| `GET`   | `/admin/catalog/services`                  | `catalog.manage` (incl. inactive) |
| `POST`  | `/admin/cities`                            | `catalog.city.manage`             |
| `PATCH` | `/admin/cities/:id`                        | `catalog.city.manage`             |
| `PATCH` | `/admin/cities/:id/activation`             | `catalog.city.manage`             |

Commission is split onto its own endpoint and its own permission code because
US-3.10 is tagged for finance as well as ops, and US-8.4 wants repricing and
rate-setting to be visibly distinct operations. An ops admin repricing a service
should not silently be able to change what Pros earn.

Three codes get added to
[`permission-code.ts`](../src/modules/identity/constants/permission-code.ts) and
to the `ops` / `finance` role definitions in [`seed.ts`](../prisma/seed.ts):

```ts
CATALOG_MANAGE: 'catalog.manage',
CATALOG_COMMISSION_SET: 'catalog.commission.set',
CATALOG_CITY_MANAGE: 'catalog.city.manage',
```

**Not city-scoped.** `CityScopeGuard` does not apply to catalog writes — the
catalog is national by ground rule, so an Indore ops user editing a price
affects Mumbai. If that is unacceptable, catalog editing must be restricted to
`super_admin`; that is a product call, flagged in §8.

---

## 5 · Business rules the service layer must enforce

Each maps to a named user story and each gets a unit test.

| Rule                                                                                           | Story          | Failure mode if skipped                                           |
| ---------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| Cannot activate a service with `commissionType` or `commissionValue` unset → `409`             | US-3.11        | Jobs complete, produce no commission, Pro is unpaid for real work |
| `commissionType = percent` ⇒ `0 < commissionValue ≤ 100`; `flat` ⇒ `commissionValue ≥ 0`       | US-3.10        | Nonsense rates reach `BookingCommission`                          |
| Cannot activate a service whose category is inactive                                           | US-3.8         | A service reachable by search but absent from every browse path   |
| Deactivating a service is **always allowed** and never touches bookings                        | US-3.7         | Deactivation cancels work already sold                            |
| Deleting a category with children or services → `409` (DB `Restrict` + a readable message)     | US-3.8         | Orphaned services                                                 |
| Category `parentId` may not create a cycle, nor point at itself                                | US-3.8         | Infinite recursion in the tree builder                            |
| Price and duration edits **never** touch existing bookings                                     | US-3.5, US-3.6 | Historical invoices silently rewrite                              |
| At least one of `allowsInstant`/`allowsScheduled`/`allowsRecurring` must be true on activation | F#3            | A live service no flow can book                                   |
| `slug` unique, immutable after creation                                                        | —              | SDUI and deep links break on rename                               |

**Not enforced here:** price snapshotting onto `Booking.flatPrice`. The column
does not exist yet — `Booking` currently has no price field at all. That is
module 4's job and is called out in §8 as an inbound dependency, not a gap.

---

## 6 · Cross-module wiring

The architecture rule is explicit: _"nothing reaches into another module's
tables directly."_ So the catalog is consumed through an exported service, never
through `prisma.service` from outside `src/modules/catalog/`.

`CatalogService` (or a sibling `ServiceCatalogService`) gains:

```ts
findServiceById(id: string): Promise<Service | null>   // incl. inactive
assertBookable(serviceId: string): Promise<Service>     // active + category active, else 404/409
getDurationMinutes(serviceId: string): Promise<number>  // Dispatch
getCommissionConfig(serviceId: string): Promise<{ type: string; value: Decimal }>  // Commission
```

| Consumer                | What changes                                                                                                                   | When        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| **Pro Management (M6)** | `ProServiceAssignmentsService.assign()` validates `serviceId` against the catalog before creating the row. **Real gap today.** | This module |
| Booking (M4)            | `assertBookable` at creation; snapshot `price` and `expectedDurationMinutes` onto the booking                                  | M4          |
| Dispatch (M5)           | `getDurationMinutes` for slot sizing and the Rule-4 tie-break                                                                  | M5          |
| Commission (M8)         | `getCommissionConfig`, snapshotted onto `BookingCommission`                                                                    | M8          |
| SDUI (M14)              | `UiConfig` JSON tree references category and service ids; publish should validate they resolve                                 | M14         |

The M6 change is the one piece of this module that edits **another module's
folder**. Keep it in its own commit — see §9.

---

## 7 · Search

Feature 6 asks for search without specifying a quality bar. Phased:

- **MVP:** `WHERE name ILIKE '%q%' OR description ILIKE '%q%'`, active only,
  capped and paginated, with an index on `lower(name)`. A national catalog is
  realistically tens-to-hundreds of rows; this is genuinely enough.
- **Upgrade path when it isn't:** `pg_trgm` + a GIN index, or a `tsvector`
  column. Note that `CREATE EXTENSION pg_trgm` needs privileges the app's RDS
  user may not have — verify before promising it.

Do not build fuzzy search in this pass. Record the seam and move on.

---

## 8 · Deferred, and why

| Item                                       | Blocked on                   | Seam                                                       |
| ------------------------------------------ | ---------------------------- | ---------------------------------------------------------- |
| Catalog feeding the SDUI home config (F#8) | M14 (Config & SDUI)          | `UiConfig` doesn't exist; ids are the contract             |
| `Booking.flatPrice` snapshot               | M4 (Booking)                 | No price column on `Booking` yet                           |
| Duration → slot sizing (half of F#7)       | M5 (Dispatch)                | `getDurationMinutes()` exists and returns the right number |
| Duration → commission tiers (half of F#7)  | **Cancelled** by ground rule | Not a dependency — it is not being built                   |
| Admin audit of catalog edits               | M15 (audit deferred)         | `updatedByAdminId` captured now                            |
| Per-city catalog scoping                   | Product decision (§2.2)      | Not in the model                                           |

---

## 9 · Build order

Each phase is one commit. Phases A3 and D touch shared or teammate-owned files
and are deliberately isolated.

| Phase  | Work                                                                                                          | Touches                                                |
| ------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **A0** | **Diff §3 against the live Eraser ERD.** Reconcile before anything else — ERD wins on shape.                  | —                                                      |
| **A1** | Add `ServiceCategory` + `Service` to the schema; migration; regenerate client                                 | `prisma/` ⚠️ shared                                    |
| **A2** | Seed a realistic category tree + services so downstream work has data                                         | `prisma/seed.ts` ⚠️ shared                             |
| **A3** | **Separate commit:** tighten `ProService.serviceId` / `Booking.serviceId` to `uuid` + FK, after the row audit | `prisma/` ⚠️ shared, high blast radius                 |
| **B**  | Read side — DTOs, tree builder, browse/search/detail endpoints, Swagger envelopes                             | `src/modules/catalog/`                                 |
| **C**  | Admin write side — category, service, commission, city CRUD + the §5 rules; new permission codes              | `src/modules/catalog/`, `permission-code.ts` ⚠️ shared |
| **D**  | **Separate commit:** `ProServiceAssignmentsService.assign()` validates against the catalog                    | `src/modules/pros/` ⚠️ **teammate's module?**          |
| **E**  | Unit specs for every §5 rule; e2e for browse + the activation gate; curl script in `test/manual/`             | tests only                                             |
| **F**  | Update `MODULE_STATUS_REPORT.md`, `API_CONVENTIONS.md` if the envelope needs anything                         | `docs/`                                                |

---

## 10 · Risks

1. **The shared RDS instance.** Both developers point at the same database, so
   migrations are not isolated — A3 in particular rewrites a column type on
   `bookings`. Verify what is actually deployed before running anything, and
   coordinate. (The prior note on this predates the move to Prisma, so confirm
   the current state rather than trusting it.)
2. **Module ownership.** Phase D edits `src/modules/pros/`. If module 6 belongs
   to the teammate, that validation call is theirs to merge — ship the exported
   `assertBookable()` and hand it over rather than editing across the boundary.
3. **`Decimal`-as-string.** `price` will serialise as `"499.00"`. The mobile
   client must not `parseFloat` it into a display total. State it in Swagger.
4. **A3 ordering.** The FK tightening must land _after_ the catalog is seeded in
   any environment with existing `pro_services` rows, or the migration fails
   mid-deploy.
5. **`isActive` default of `false`** will surprise anyone creating a service and
   expecting to see it in browse. It is deliberate (US-3.11); document it on the
   create endpoint.

---

## 11 · Definition of done

- [ ] §3 reconciled against the live ERD, deviations recorded
- [ ] 8/8 features either built or explicitly deferred with a named blocker
- [ ] Every §5 rule has a passing unit test
- [ ] `ProService.serviceId` and `Booking.serviceId` are real, typed FKs
- [ ] A service cannot go live without a valid commission rate
- [ ] Inactive services vanish from browse but still resolve by id
- [ ] `npm run build && npm run typecheck && npm run lint && npm run test:e2e` clean
- [ ] Curl run against a real boot, in the style of the 2026-08-08 reports
- [ ] `MODULE_STATUS_REPORT.md` updated
