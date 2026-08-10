# Full API cURL Test Report — all built modules

**Date:** 2026-08-10
**Scope:** modules 1, 2, 3, 4, 5 and 6, driven through the public HTTP API
**Result:** **116 / 116 assertions passed** after fixing one product defect
**Runner:** [`test/manual/run-full-curl-suite.sh`](../../test/manual/run-full-curl-suite.sh)

---

## Executive result

| Layer                       | Result                    |
| --------------------------- | ------------------------- |
| Full cURL suite             | **116 / 116**             |
| Unit tests                  | **26 suites / 247 tests** |
| e2e tests                   | **6 suites / 130 tests**  |
| `tsc --noEmit`              | Pass                      |
| `nest build`                | Pass                      |
| `eslint --max-warnings=0`   | Pass                      |
| Live schema ↔ Prisma schema | No difference detected    |

Run against a real PostgreSQL 18 database (`homingo_dev` on localhost), a real
migrated schema, and the app booted from `dist/`. The OTP provider, Redis and
Nominatim are local test doubles; everything else is the genuine stack.

---

## One product defect found and fixed

### Commission was leaking on the public catalogue — US-3.2 violation

`GET /catalog/services`, `/catalog/categories`, `/catalog/categories/:id/services`
and `/catalog/services/:id` are **unauthenticated** — a first-time user browses
before signing in. All four returned the raw `Service` row, including:

```json
"commissionType": "percent",
"commissionValue": "35"
```

US-3.2's ripple is unambiguous: **"The platform/Pro split never appears on any
customer-facing surface."** Anyone could read the platform's margin on every
service without a token.

**Why the existing tests missed it.** The Swagger contract test asserts that
`ServiceDto` excludes commission, and it does. But a DTO in this codebase is
Swagger metadata — the `@nestjs/swagger` plugin reads it to generate docs, and
it performs **no runtime filtering**. The controller returned the Prisma row and
the response interceptor serialised whatever it was handed. The published
contract and the actual payload disagreed, and only a real HTTP call could show
that.

**Fix.** A `toPublicService()` mapper applied to all four public read paths,
plus `getPublicServiceOrFail()` for the by-id route. Admin routes and the
cross-module lookups other modules depend on keep the full row — commission
still has to reach module 8, it just must not reach a customer. Five unit tests
now cover the mapper, the list, the tree, the by-id read, and the fact that the
internal lookup still returns it.

---

## What the suite covers

116 assertions, weighted toward the edge cases the user stories call out rather
than the happy paths.

### M1 · Identity & Access

Wrong OTP code refused (`401`), 10-digit Indian mobiles canonicalised to `+91`,
malformed phone refused, missing bearer token (`401`), customer token on an
admin route (`403`), unknown admin cannot self-register (`404`), and **OTP
requests rate limited per phone** — the sixth request inside the window returns
`429`.

### M2 · Customer Profile

Unknown body fields are **rejected, not stripped** (`400`) — a typo'd field
fails loudly instead of looking saved. First address auto-defaults, the second
does not, promotion works, `geoPoint` is derived from the pin, and reverse
geocoding resolves. **Ownership non-disclosure holds**: another customer's
address id is indistinguishable from one that never existed.

### M3 · Service Catalog

Browse works unauthenticated; the tree is provably two levels deep; a third
level is refused (`409`); duplicate slugs refused. Services are **created as
drafts**, and:

- **US-3.11** — activating without a commission rate is refused (`409`)
- a `percent` rate above 100 is refused (`400`), while a `flat` rate above 100 is allowed, because it is rupees
- **repricing provably does not touch the commission**
- **US-3.8** — deleting a category that still holds services is refused (`409`)
- **US-3.9** — launching a city with no approved Pros is refused (`409`), and ops can override deliberately

### M4 · Booking & Job Lifecycle

Online booking refused with a documented `501` while Payments is unbuilt; cash
**skips `awaiting_payment`**; price frozen from the catalogue; slot window set
even for instant bookings; human-readable booking number; a past slot refused;
booking against someone else's address refused (`404`); **`Idempotency-Key`
returns the original booking** rather than creating a second; rebook records its
lineage.

Through the job: **US-4.9's `arrived → en_route → arrived` repeat is allowed**;
a wrong start code is refused and does not start the timer; **US-4.16 —
completion refused without a photo**; a photo key from another booking is
refused; completion produces an invoice, tax and actual duration; a completed
job cannot be cancelled. Chat carries **no contact details**. `GET
/bookings/:id/tracking` returns a null ETA, honestly, until module 13 exists.

Cancellation: window B correctly identified, charges no fee, attributes to the
customer, and cannot be repeated.

**US-4.24** — the dispute reconstruction returns the timeline, photo proofs and
chat thread in **one** call.

### M5 · Dispatch Engine

Bookings are queued on creation, drained, and **assigned automatically**. Every
candidate persists its score inputs, travel origin and smoothed rating.
Acknowledgement works and is idempotent. **There is no accept route and no
decline route** — both return `404`, asserted explicitly.

### M6 · Pro Management

`serviceId` is validated against the catalogue — assigning a non-existent
service returns `404`, which is the gap module 3 closed. Duplicate assignment
refused (`409`).

### Envelope

Every response carries `success`, `statusCode`, `message`, `data` and
`timestamp`.

---

## Three "failures" that were the engine being right

Worth recording, because each looked like a bug and was not:

1. **`no_supply`** — dispatch refused to assign because the test Pro held a
   _different_ service than the one booked. Exactly US-5.5's supply-gap
   distinction working.
2. **`exhausted`** — the Pro had two overlapping committed bookings from an
   earlier run, so Rule 1 correctly found no free window.
3. **City mismatch** — the Pro was seeded into Bhopal while the address
   geocoded to Indore. Rule 1 filters on city, so they were correctly invisible.

All three were fixed in the harness, not the product.

---

## Known limitations of this run

- **Test doubles, not managed services.** The OTP provider is the mock, Redis is
  the in-repo double, and Nominatim is the deterministic fixture server. No SMS
  was sent, no S3 bytes uploaded, no real geocoder called.
- **Local PostgreSQL, not RDS.** Deliberate — see the recommendation in
  [`MODULE_STATUS_REPORT.md`](../MODULE_STATUS_REPORT.md) on why the shared
  cloud instance should not be a test target.
- **Unbuilt modules are unbuilt.** Online payment (`501`), ETA, push
  notifications, the `no_start` ticket and reviews are all absent by design, and
  the suite asserts the honest response rather than skipping them.
- **The suite needs clean transactional data.** It is re-runnable — slugs and
  phone numbers are unique per run — but a Pro carrying committed bookings from
  a previous run will legitimately be unavailable, so truncate bookings between
  full runs.

## Reproduction

```bash
# migrated + seeded database, app on :53000, doubles on :56379 and :58080
APP_LOG=<app stdout log> PRO_SETUP_SQL=<approve-pro script> \
  bash test/manual/run-full-curl-suite.sh
```

Module-specific suites also exist:
[`run-booking-lifecycle-curl.sh`](../../test/manual/run-booking-lifecycle-curl.sh) (24 assertions)
and [`run-dispatch-curl.sh`](../../test/manual/run-dispatch-curl.sh) (19).
