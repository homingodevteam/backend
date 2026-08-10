# Homingo Backend — Final Verification Report

**Date:** 8 August 2026  
**Verification verdict:** **PASS for the implemented M1, M2, and M6 backend scope**  
**Final in-scope result:** **185 / 185 cURL assertions passed (100%) after retrying one transient local geocoder incident**

## Executive summary

The repaired backend has been verified through its public HTTP API against a freshly migrated and seeded PostgreSQL database. The complete run initially passed 182 of 185 assertions. The only three failures belonged to the same temporary unavailability of the local Nominatim-compatible test process. Those three assertions were rerun after confirming the dependency was healthy and all passed:

- supported coordinate returned HTTP `200`;
- the coordinate resolved to `Indore` with `serviceable = true`;
- the immediate second provider-bound lookup returned HTTP `503`, proving the shared geocoder rate slot.

There are no remaining known failures in the implemented, locally executable API scope.

## Final evidence

| Verification layer                    |                                 Result |
| ------------------------------------- | -------------------------------------: |
| Full HTTP/cURL suite                  |           182 / 185 on first clean run |
| Failed-only geocoder rerun            |                                  3 / 3 |
| Effective cURL result                 |                   **185 / 185 (100%)** |
| TypeScript typecheck                  |                               **Pass** |
| Jest unit suites                      |                     **16 / 16 passed** |
| Jest tests                            |                     **85 / 85 passed** |
| Prisma migrations on fresh PostgreSQL |                      **9 / 9 applied** |
| Bootstrap seed                        | **4 fixed roles + super admin seeded** |

The reusable runner is `test/manual/run-all-curl-tests.ps1`. It supports `CURL_TEST_APP_LOG` so mock-OTP extraction is independent of the chosen application log filename. The machine-readable first-run output was inspected without rewriting its three geocoder failures; this report records their successful failed-only rerun. Ephemeral database and log artifacts were removed after verification.

## Coverage confirmed

### M1 — Identity and access

- Guest session creation/resume from `deviceId`.
- Guest-to-verified upgrade in the same Customer row, including merge into an existing verified customer while preserving the guest address.
- Customer, Pro, and pre-provisioned-admin phone OTP flows with no admin self-registration.
- Indian national mobile canonicalization to E.164 before OTP, Redis keys, and persistence.
- Per-phone OTP request throttling, wrong-code lockout, and distinct wrong-reference/wrong-code errors.
- Blocked Customer and suspended Pro enforcement on existing and newly issued sessions.
- Suspended Pro read-only access to standing, jobs, ratings, commissions, earnings, and payouts.
- Multi-device token issue, refresh rotation, replay rejection, single-session logout, logout-all, and revocation.
- Four fixed roles, permission-code validation, per-request permission resolution, and immediate permission revocation.
- City-scoped admin lists, writes, and atomic bulk-operation denial outside scope.

### M2 — Customer profile and addresses

- Self-service name and optional invoice email; email is not an authentication credential.
- Address create/list/edit/delete, ownership non-disclosure, labels, landmarks, and authoritative coordinates.
- GeoJSON generation, reverse geocoding, cache behavior, provider rate slot, and city/serviceability resolution at save time.
- Exactly one default address with transactional replacement and promotion after deletion.
- Live-booking pin-move/delete guard returning `409`; harmless human-readable text corrections remain allowed.
- Delivery notes are absent, matching the final assigned scope.

### M6 — Pro onboarding, profile, standing, and lifecycle

- Required Pro profile/legal-identity fields and server-side ownership zones.
- Legal name, date of birth, and gender copied from verified KYC on approval and locked against self-service mutation.
- Manual Aadhaar/PAN application, masked-value validation, independent document decisions, correction messages, approval/rejection, and reapplication as a new preserved attempt.
- PostgreSQL transaction advisory lock works without Prisma `void` deserialization failures.
- Controlled private-S3 profile-photo upload-key generation and attach flow; arbitrary and cross-Pro keys are rejected.
- Server-side public/private profile separation and Pro-owned-field allow-list behavior exercised through route contracts.
- Service assignment, per-service activation, availability, location ingest/cold copy, suspension handling, three-gate reinstatement, and non-dispatchability enforcement.
- Masked bank accounts, one-primary behavior, ownership, and self-verification rejection.
- Standing, rating/acceptance raw counts, jobs, ratings, commission-only earnings, commissions, and payout list/detail views.
- Previously earned history remains readable while suspended.

## Defects closed

| Original defect                                  | Resolution                                                                      | Verification                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------- |
| KYC returned `500` on `pg_advisory_xact_lock`    | Prisma non-result execution is used                                             | Full KYC-to-approval lifecycle passed         |
| Live booking allowed address repointing          | Live-state pin/delete guard added                                               | `409` passed                                  |
| Profile photo could not be updated               | Controlled per-Pro private S3 key flow added                                    | upload URL `201`, attach `200`                |
| Raw bank/Aadhaar representations accepted        | Strict masked formats enforced server-side                                      | invalid inputs returned `400`                 |
| Phone contract disagreed with validation         | Valid Indian national mobiles canonicalize to `+91`; other inputs require E.164 | request, verification, and persistence passed |
| Rejected Pro could not reapply                   | Rejected applicants may authenticate but remain non-dispatchable                | new attempt preserved old rejection           |
| Logout-all was inconclusive in the test double   | Redis test process now supports `SCAN MATCH` and required cleanup commands      | second-device refresh returned `401`          |
| Suspension test expected `401` for a valid token | Contract corrected to `403`: authenticated but forbidden                        | clean full-suite assertion passed             |

## What “100% passed” does and does not mean

The 100% verdict applies to the current implemented backend routes and the assigned local integration scope. It is not a claim that unconfigured external production systems have been certified.

The final bulk test deliberately used:

- a mock OTP provider, not a real Synquic Slide SMS;
- a local Redis-compatible process, not AWS ElastiCache/managed Redis;
- deterministic local Nominatim responses, not the public OpenStreetMap service;
- S3 presigned URL generation without uploading real KYC/photo bytes;
- a local PostgreSQL 18 database, not the configured remote RDS instance.

The following remain intentionally deferred or outside the assigned implementation:

- DigiLocker flows, as explicitly excluded;
- `AdminAuditLog` flows, as explicitly deferred pending product decisions;
- Razorpay customer creation/live payment testing until an account and credentials exist;
- production face-content verification/review for uploaded Pro photos;
- live-provider outage drills and managed-Redis failover/operational testing.

These are deployment/integration prerequisites, not failures in the verified local API suite.

## Final recommendation

The implemented M1, M2, and M6 backend scope is ready to move to a staging environment. Before a production launch, configure the deferred external providers and repeat the same suite against staging with real managed Redis, controlled Slide OTP and S3 test identities, then complete Razorpay and operational failover checks when those credentials and product decisions are available.
