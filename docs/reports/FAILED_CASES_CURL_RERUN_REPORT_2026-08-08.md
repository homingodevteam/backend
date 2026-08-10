# Failed Cases — Fix and cURL Rerun Report

**Date:** 8 August 2026  
**Result:** **All targeted failed behaviors resolved**  
**Scope:** Only cases that failed, cascaded, or were inconclusive in the original 183-assertion run were revisited. The original 148 passing assertions were not rerun.

## Verification result

| Run                       | Scope                                                   | Passed | Failed |
| ------------------------- | ------------------------------------------------------- | -----: | -----: |
| Focused failed-case rerun | Repaired root cases and previously blocked lifecycle    |     42 |      1 |
| Remaining-case rerun      | Rejected-Pro authentication and new application attempt |      3 |      0 |
| Final static verification | TypeScript typecheck                                    |   Pass |      0 |
| Final unit verification   | 16 Jest suites / 85 tests                               |     85 |      0 |

The focused run exposed one additional problem hidden by the original KYC failure: a rejected Pro could not access the application endpoint to reapply. That auth rule was corrected, and only that remaining case was rerun. It passed all three assertions: authentication, submission, and preservation of the earlier rejected attempt under a different application ID.

## Fixes implemented

### KYC transaction lock

Changed the transaction-scoped advisory lock from Prisma `$queryRaw` to `$executeRaw`. PostgreSQL's `pg_advisory_xact_lock` returns `void`; the old method tried to deserialize it and returned HTTP `500`.

Real PostgreSQL/cURL verification now passes:

- Valid manual KYC submission: `201`.
- Pending resubmission updates the same application: `201`, same ID.
- Independent Aadhaar/PAN review: `200`.
- Early approval before both documents: `409`.
- Document view URL and verification call: `200`.
- Approval: `200`, with legal identity and employee code copied to Pro.
- Approved legal identity resubmission: `409`.
- Correction request, rejection, final-decision protection, and reapplication lifecycle: pass.

### Rejected-Pro reapplication access

Removed the auth-layer rejection of `Pro.status = rejected`. A rejected Pro is not dispatchable—the service, availability, and approved-status gates still prevent work and location ingest—but they can authenticate and create the required new `ProApplication` attempt.

Verified:

- Rejected Pro OTP verification: `201`.
- New application attempt: `201`.
- Previous rejected application remains stored and the new attempt has a new ID.

### Live-booking address protection

Customer address pin changes now query live bookings in these states:

```text
created, assigning, assigned, en_route, arrived, started
```

Moving the authoritative pin returns `409` with an instruction to create a new address. Address deletion is protected by the same guard. Human-readable text can still be corrected without silently moving the Pro's destination.

Focused cURL result: live `en_route` booking plus pin update returned `409`.

### Controlled Pro profile photo flow

Added:

```text
POST  /api/v1/pros/me/profile-photo/upload-url
PATCH /api/v1/pros/me/profile-photo
```

The Pro first receives an S3 upload key under their own `profile-photos/<proId>/` prefix. The attach endpoint accepts only a generated UUID key belonging to the authenticated Pro. Arbitrary external URLs and another Pro's key are rejected.

Focused cURL results:

- Arbitrary URL: `400`.
- Generate upload URL: `201`.
- Attach issued key: `200`.

The database stores the private S3 object key rather than an expiring signed URL. Face-content verification remains a separate external review capability; it was not fabricated in this pass.

### Server-side masking validation

The API no longer trusts a field merely because it is named `Masked`.

Enforced formats:

```text
Aadhaar: XXXX-XXXX-1234
PAN:     XXXXX1234X
Bank:    XXXXXXXX9012 (four or more X characters plus last four digits)
```

Focused cURL results:

- Raw 12-digit Aadhaar: `400` before persistence.
- Raw bank account number: `400` before persistence.
- Properly masked KYC values complete the approval lifecycle.

### Phone canonicalization

Authentication DTOs now normalize a valid ten-digit Indian mobile number to E.164 before OTP rate-limit keys, provider calls, database lookups, and uniqueness logic.

Example:

```text
6266941709 -> +916266941709
```

Other phone inputs must already be valid E.164. Focused cURL verification confirmed request, OTP verification, and stored canonical phone value.

### Logout-all test coverage

The local Redis-compatible test process now implements `SCAN MATCH`, allowing `revokeAllSessions` to find every device session. It also tolerates ordinary client connection resets and supports the GEO removal command used during suspension.

Focused cURL result:

- Logout-all: `204`.
- Refresh from the second device afterward: `401`.

This fixes the earlier inconclusive local test; production should still use managed/real Redis.

### Correct secure expectations

- Explicitly requesting an out-of-scope city roster returns `403`. This was retained as the correct secure behavior.
- An already-issued access JWT is not made cryptographically invalid by suspension. Account state is resolved per request, and ordinary Pro endpoints immediately return `403` with suspended read-only access. Refresh sessions are revoked. The rerun uses this correct expectation.

## Previously cascaded lifecycle now verified

With KYC approval working, the focused cURL flow successfully reached:

```text
manual KYC
  -> independent document verification
  -> approval and legal-field lock
  -> active ProService
  -> admin availability on
  -> live location ingest and PostgreSQL cold copy
  -> live-booking suspension handling
  -> immediate suspended read-only enforcement
  -> inactive-service reinstatement blocker
  -> all three gates restored
  -> successful reinstatement
```

Key results:

- Approved/on-duty location: `201`; cold coordinate and timestamp persisted.
- Suspension without live-booking decision: `409`.
- Confirmed handling without reason: `400`.
- Valid suspension: `200`; pre-arrival booking returned to `assigning` with no Pro.
- Ordinary suspended profile read/write: `403`.
- Inactive service blocks reinstatement: `409`.
- Active service + availability + suspended status permits reinstatement: `200`.

## Reproduction files

- `test/manual/rerun-failed-curl-tests.ps1` — focused rerun of failed and cascaded cases.
- `test/manual/rerun-reapplication-case.ps1` — rerun of only the one issue exposed by the focused pass.
- `test/manual/redis-test-server.mjs` — corrected local Redis-compatible process.
- `test/manual/nominatim-test-server.mjs` — deterministic geocoder used for address setup.

No remote RDS records, real SMS recipients, or real KYC files were used.
