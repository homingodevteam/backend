# All Implemented Modules — cURL Test Report

> Historical first-run report. The listed defects were subsequently fixed and rerun. The final verification reached 185/185 after a failed-only transient geocoder retry; see `FINAL_VERIFICATION_REPORT_2026-08-08.md` for the current verdict and `FAILED_CASES_CURL_RERUN_REPORT_2026-08-08.md` for the repair evidence.

**Date:** 8 August 2026  
**Overall result:** **Not release-ready**  
**Raw cURL assertions:** **183 total — 148 passed, 35 failed**  
**Supporting checks:** TypeScript typecheck passed; Jest passed **15/15 suites and 80/80 tests**.

## Executive result

Every registered API route in the current application was exercised through real HTTP requests made by `curl.exe`. The test covered the core/health API, catalog, identity and sessions, roles and admin users, customer profile and addresses, admin customer moderation, Pro profile, manual KYC onboarding, service assignment, availability/location, bank accounts, Pro standing/history, suspension, and reinstatement.

The 35 raw failures are not 35 independent defects:

- **6 confirmed implementation defects** were found.
- **27 additional assertions cascade from one KYC submission defect** that prevents a Pro from becoming approved (18 inside KYC and 9 in location/suspension/reinstatement).
- **1 assertion is a Redis test-double limitation**, not a confirmed product failure.
- **1 assertion is acceptable secure behavior** (`403` instead of an empty out-of-scope list).
- The remaining failed property/route assertions are direct consequences of the KYC cascade.

The highest-priority blocker is `POST /pros/me/applications`: every otherwise valid manual KYC submission returns HTTP `500`.

## Environment and safety

- Real compiled Nest application on `127.0.0.1:53000`.
- Fresh isolated PostgreSQL 18 database: `homingo_curl_test` on `127.0.0.1:55432`.
- All **9 Prisma migrations** and the canonical four-role seed were applied.
- Local Redis-compatible process used for OTP references, rate limits, lockouts, and sessions.
- Deterministic local Nominatim-compatible server used for Indore, Mumbai, and unsupported-city flows. This avoided unstable public-network results while exercising the real geocoder adapter, cache, city matcher, and serviceability code.
- `OTP_PROVIDER=mock` used; no real SMS was sent. The real auth controller, rate limit, lockout, Redis, actor resolution, and JWT flows were exercised.
- S3 presigned URL generation was exercised without uploading real identity documents.
- The configured remote RDS database was **not used or changed**.
- API keys, OTP codes, provider references, JWTs, document URLs, and credentials are excluded from this report.

## Coverage summary

| Area                | Assertions |  Passed | Failed |
| ------------------- | ---------: | ------: | -----: |
| Core                |          3 |       3 |      0 |
| Catalog             |          2 |       2 |      0 |
| Validation          |          1 |       1 |      0 |
| Authorization       |          2 |       2 |      0 |
| Guest               |          4 |       4 |      0 |
| Session             |          6 |       5 |      1 |
| OTP                 |          7 |       6 |      1 |
| Guest upgrade       |          1 |       1 |      0 |
| Customer profile    |          4 |       4 |      0 |
| Address             |         22 |      22 |      0 |
| Ownership           |          4 |       4 |      0 |
| Address guard       |          1 |       0 |      1 |
| Admin auth          |          4 |       4 |      0 |
| Roles               |          6 |       6 |      0 |
| Admin users         |          8 |       8 |      0 |
| Permissions         |          3 |       3 |      0 |
| Customer moderation |          6 |       6 |      0 |
| Pro auth            |          1 |       1 |      0 |
| Pro profile         |          5 |       4 |      1 |
| Pro location        |          3 |       1 |      2 |
| KYC                 |         10 |       6 |      4 |
| KYC security        |          1 |       0 |      1 |
| Admin Pro profile   |          2 |       2 |      0 |
| KYC admin           |          9 |       2 |      7 |
| KYC approval        |          1 |       0 |      1 |
| KYC lifecycle       |          7 |       0 |      7 |
| Pro services        |          4 |       4 |      0 |
| Availability        |          3 |       3 |      0 |
| Bank security       |          2 |       1 |      1 |
| Bank                |          5 |       5 |      0 |
| Pro history         |         11 |      11 |      0 |
| City scope          |          6 |       5 |      1 |
| Suspension          |          9 |       3 |      6 |
| Suspended history   |          7 |       7 |      0 |
| Reinstatement       |          7 |       6 |      1 |
| OTP limits          |          2 |       2 |      0 |
| Guest merge         |          4 |       4 |      0 |
| **Total**           |    **183** | **148** | **35** |

## Confirmed defects

### P0 — Valid manual KYC submission returns 500

**Endpoint:** `POST /api/v1/pros/me/applications`  
**Expected:** `201` with a new or updated application.  
**Actual:** `500 Internal server error`.

The transaction executes:

```ts
await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${proId}, 0))`;
```

PostgreSQL returns `void`; Prisma attempts to deserialize that value and throws:

```text
Failed to deserialize column of type 'void'.
```

This blocks submission, resubmission, independent document review, correction messages, approval/rejection, legal-field copying, employee-code issuance, and reapplication. It also leaves the Pro in `applied`, which makes the later positive location, suspension, and reinstatement cases fail.

**Recommended correction:** execute the lock as a non-result command, or cast the result to a Prisma-supported type. Add a real PostgreSQL integration test; the mocked unit test does not catch this adapter/runtime behavior.

### P0 — In-flight booking does not guard address edits

**Endpoint:** `PATCH /api/v1/customers/me/addresses/:id`  
**Expected:** `409` when the address is referenced by a live booking.  
**Actual:** `200`; the address text was changed while a live booking referenced it.

The service still contains a stale TODO saying Booking does not exist, although Booking is now present in the schema. The guard must query live booking statuses before any address update that can change the routing contract. Pin changes are the critical case; blocking all edits or allowing only harmless label/text changes must be an explicit product decision.

### P1 — Pro cannot save a profile photo URL

**Endpoint:** `PATCH /api/v1/pros/me`  
**Expected:** `200` for `profilePhotoUrl` after upload/review.  
**Actual:** `400 Validation failed`.

`UpdateProDto` does not allow `profilePhotoUrl`, even though the assigned M6 ownership zone makes the photo Pro-editable. Upload, face verification/review state, and a controlled save path still need to be connected.

### P1 — Unmasked bank account number is accepted

**Endpoint:** `POST /api/v1/pros/me/bank-accounts`  
**Expected:** `400` for `accountNumberMasked: "123456789012"`.  
**Actual:** `201`; the raw-looking value was stored.

The API trusts the client-provided field name and applies no masking-format validation. Masking must be performed or strictly enforced server-side. Client naming is not a security boundary.

### P1 — Aadhaar masking is not enforced

The cURL request with an unmasked 12-digit Aadhaar value reached the KYC transaction and then failed on the advisory-lock defect. Source inspection confirms that the DTO accepts any string and the service does not validate/mask it. Once the KYC blocker is fixed, this request would otherwise be stored.

**Required behavior:** never persist or log the full Aadhaar number in the general application row/list response. Validate the masked representation server-side, or accept the raw value only in a narrowly controlled path that transforms it before persistence.

### P2 — “International format” validator accepts a national number

**Endpoint:** `POST /api/v1/auth/otp/request`  
**Input:** `6266941709`  
**Expected from the validation message/documentation:** `400`.  
**Actual:** `201`; OTP request accepted.

The regex uses an optional `+` (`^\+?[1-9]\d{7,14}$`). Decide whether the API canonicalizes Indian national numbers to E.164 or strictly requires `+91...`; the current behavior and error message disagree.

## Cascaded failures from the KYC blocker

These raw failures are downstream effects, not separate root causes:

- Valid KYC submit and open-attempt resubmit returned `500`.
- Application ID was absent, so admin document review, view URL, call log, decision, and final-decision protection requests used an empty ID and returned `500`.
- Approval never copied legal name/DOB/gender or generated the employee code.
- Correction-request, rejection, and new-attempt reapplication flows could not proceed.
- The Pro remained `applied`; approved/on-duty location ingest therefore returned `403`.
- Suspension returned `409 Cannot suspend a Pro with status "applied"`; token revocation, live-booking reassignment, suspended profile denial, and the final reinstatement success could not be reached honestly.

The suspended-history endpoints themselves were tested with the suspended-access path available to the guard and all seven returned `200`, but the end-to-end state transition needs rerunning after KYC is repaired.

## Non-defects and test limitations

### Out-of-scope roster query returned 403

An Indore-scoped ops token requesting `GET /admin/pros?cityId=<Mumbai>` received `403`, while the harness expected `200` with an empty list. This is secure and satisfies the no-leak requirement. Normal unfiltered roster scoping passed, out-of-city writes returned `403`, and mixed-city bulk mutation was denied atomically.

### Logout-all with the lightweight Redis test process

`POST /auth/logout-all` returned `204`, but a second device refresh token remained usable. The local Redis test process intentionally implements `SCAN` as an empty result, while production `revokeAllSessions` depends on `SCAN MATCH session:<actor>:<id>:*`. This result is **inconclusive**, not a confirmed application defect. Retest against real Redis before release. Single-session logout, refresh rotation, replay rejection, account blocking, and admin deactivation all passed.

### External providers not called live

- Synquic Slide transport and provider-outage mapping were not called with a real phone in this bulk suite. They remain unit-tested; a single controlled live SMS test should be run separately.
- S3 URLs were generated, but no real Aadhaar/PAN bytes were uploaded.
- Razorpay has no current route and credentials are intentionally not configured, so it was outside the executable API inventory.

## Major passing flows

- Consistent success/error envelopes, health, active-city catalog, malformed JSON, and unknown-route handling.
- Guest creation/resume, refresh rotation, single logout, replay rejection, actor isolation, and no admin self-registration.
- Customer OTP login, wrong-reference and wrong-code errors, five-request throttle, five-wrong-code lockout, blocked login, guest upgrade in place, verified-customer merge, guest-row discard, and address preservation.
- Customer profile ownership and invoice-email normalization; phone rejected from profile mutation.
- Reverse geocoding, cache hit, shared one-request-per-second slot, coordinate validation, city resolution, unsupported city, exact GeoJSON pin, first/default address behavior, exactly-one-default transaction, pin re-resolution, ownership non-disclosure, deletion, and default promotion.
- Four fixed seeded roles, role-code validation, admin provisioning, duplicate protection, deactivation, permission denial, and per-request permission revocation.
- Customer block/unblock and immediate access enforcement.
- Pro applied-state creation, self-edit allow-list, legal-name rejection, off-duty location denial, and S3 upload URL validation.
- Admin city/salary ownership, service assignment uniqueness, per-service suspension/update, single and bulk availability.
- Bank-account ownership, exactly one primary account, and Pro self-verification rejection.
- Standing calculations expose raw acceptance counts and correctly state that rating affects dispatch while acceptance does not.
- Job, rating, commission-only earnings, commission, payout list/detail, date/pagination validation, and foreign payout non-disclosure.
- Suspended-access allow-list returned readable standing, jobs, ratings, earnings, commissions, payouts, and payout details.

## Route inventory exercised

| Module         | Routes exercised                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core/catalog   | `GET /`, `GET /health`, `GET /cities`                                                                                                                     |
| Auth           | guest session, OTP request/verify, refresh, logout, logout-all                                                                                            |
| Admin identity | role list/create/update; admin-user list/create/update                                                                                                    |
| Customer       | profile get/update; reverse geocode; address list/create/update/delete/default; serviceability                                                            |
| Customer admin | block and unblock                                                                                                                                         |
| Pro            | profile get/update; standing/jobs/ratings/earnings/commissions/payouts/detail; location; application list/submit; KYC upload URL; bank list/create/update |
| Pro admin      | application queue/verify/view/call/decision; roster; profile/suspend/reinstate/availability/bulk; service assign/update                                   |

## Reproduction

The reusable all-module runner is:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/manual/run-all-curl-tests.ps1
```

It expects an isolated migrated database on port `55432`, the included Redis-compatible process on `56379`, the deterministic Nominatim test server on `58080`, and the API on `53000`. It writes the machine-readable assertion results to:

```text
.curl-test-runtime/all-curl-results.json
```

Supporting test server:

```powershell
node test/manual/nominatim-test-server.mjs
```

The runner deliberately exits non-zero while any expected behavior fails.

## Release recommendation

Do not release the M6 onboarding flow until the advisory-lock query is corrected and the full KYC → approval → service → availability → location → suspension → reinstatement chain is rerun through HTTP. Before production, also enforce server-side Aadhaar/bank masking, implement the in-flight address guard and controlled photo update path, and repeat logout-all against real Redis.
