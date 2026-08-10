# M1 Identity and Access cURL Test Report

Date: 8 August 2026  
Result: **30 passed, 0 failed**

## Test environment

- Real compiled Nest application listening on `127.0.0.1:53000`.
- All HTTP requests were made with `curl.exe`; the reusable runner is `test/manual/run-curl-smoke.ps1`.
- Fresh isolated PostgreSQL 18 database with all five project migrations and the four-role seed applied.
- Local Redis-compatible test process for sessions, OTP counters, references and lockouts.
- `OTP_PROVIDER=mock` was used so the test did not send unsolicited SMS messages. The same controller, AuthService, Redis and token paths were exercised; only the external Slide transport was replaced.
- Tokens, OTPs, provider references, phone numbers and credentials are redacted from this report.

The configured AWS RDS endpoint was reachable over TLS, but the current `.env.local` database password was rejected by PostgreSQL. No production/RDS records were changed.

## Results

| Area            | cURL assertion                               |              Expected |                Actual | Result |
| --------------- | -------------------------------------------- | --------------------: | --------------------: | ------ |
| Health          | Liveness endpoint                            |                   200 |                   200 | Pass   |
| Health          | Database and heap readiness                  |                   200 |                   200 | Pass   |
| Validation      | Invalid guest `deviceId`                     |                   400 |                   400 | Pass   |
| Authentication  | Protected route without bearer token         |                   401 |                   401 | Pass   |
| Guest           | Create session from `deviceId`               |                   201 |                   201 | Pass   |
| Guest           | Read guest customer profile                  |                   200 |                   200 | Pass   |
| Actor isolation | Customer token on admin endpoint             |                   403 |                   403 | Pass   |
| Session         | Rotate refresh token                         |                   201 |                   201 | Pass   |
| Session         | Revoke one session                           |                   204 |                   204 | Pass   |
| Session         | Reuse revoked refresh token                  |                   401 |                   401 | Pass   |
| Admin security  | OTP request for unknown admin                |                   404 |                   404 | Pass   |
| Customer OTP    | Request OTP/provider reference               |                   201 |                   201 | Pass   |
| Customer OTP    | Incorrect OTP                                |                   401 |                   401 | Pass   |
| Customer OTP    | Correct OTP and guest upgrade                |                   201 |                   201 | Pass   |
| Guest upgrade   | Customer ID preserved                        |               Same ID |               Same ID | Pass   |
| Customer        | Read verified profile                        |                   200 |                   200 | Pass   |
| Admin OTP       | Pre-provisioned admin OTP request            |                   201 |                   201 | Pass   |
| Admin OTP       | Admin OTP verification                       |                   201 |                   201 | Pass   |
| RBAC            | Super-admin lists four roles                 |                   200 |                   200 | Pass   |
| Blocking        | Admin blocks customer                        |                   200 |                   200 | Pass   |
| Blocking        | Existing customer access denied immediately  |                   401 |                   401 | Pass   |
| Pro OTP         | Pro OTP request                              |                   201 |                   201 | Pass   |
| Pro OTP         | Pro OTP verification                         |                   201 |                   201 | Pass   |
| Suspension      | Admin suspends approved Pro                  |                   200 |                   200 | Pass   |
| Suspension      | Suspended Pro denied non-financial route     |                   403 |                   403 | Pass   |
| City scope      | Indore ops admin OTP login                   |                   201 |                   201 | Pass   |
| City scope      | Roster contains only Indore Pro              |                   200 |                   200 | Pass   |
| City scope      | Mumbai Pro mutation by Indore admin          |                   403 |                   403 | Pass   |
| City scope      | Mixed-city bulk mutation rejected atomically |                   403 |                   403 | Pass   |
| OTP rate limit  | Six requests to one phone                    | `201 × 5`, then `429` | `201 × 5`, then `429` | Pass   |
| OTP lockout     | Six wrong verification attempts              | `401 × 5`, then `429` | `401 × 5`, then `429` | Pass   |

## Representative cURL commands

```bash
curl -i http://127.0.0.1:53000/api/v1/health

curl -i -X POST http://127.0.0.1:53000/api/v1/auth/guest-session \
  -H "Content-Type: application/json" \
  --data '{"deviceId":"curl-device-0001"}'

curl -i -X POST http://127.0.0.1:53000/api/v1/auth/otp/request \
  -H "Content-Type: application/json" \
  --data '{"phone":"<redacted>","actorType":"customer"}'

curl -i http://127.0.0.1:53000/api/v1/customers/me \
  -H "Authorization: Bearer <redacted-access-token>"

curl -i -X PATCH http://127.0.0.1:53000/api/v1/admin/pros/<mumbai-pro-id>/suspend \
  -H "Authorization: Bearer <redacted-indore-admin-token>" \
  -H "Content-Type: application/json" \
  --data '{}'
```

## Findings and limits

1. The tested M1 HTTP flows behaved as scoped, including immediate account-state enforcement, refresh revocation, OTP throttling, wrong-code lockout, RBAC and city isolation.
2. Swagger error declarations were missing the implemented OTP `429` and provider `503` responses. They were updated after this run.
3. Synquic Slide itself was not called during this automated suite. A live Slide test requires an intentional SMS recipient and valid external credentials. Slide transport/error mapping remains covered by unit tests.
4. Provider-outage `503` behavior cannot be produced honestly with the local mock transport; it remains unit-tested rather than marked as a cURL pass.
5. Positive access for suspended Pros to earnings/payout history cannot be cURL-tested because those endpoints do not exist yet. The negative restriction on all current non-financial Pro routes passed.
6. Booking-address city resolution and export scoping cannot be cURL-tested until Booking/export routes exist.

## Reproduction

Run the API with an isolated migrated database and Redis, then execute:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/manual/run-curl-smoke.ps1
```

The runner writes a token-redacted machine-readable result file to `.curl-test-runtime/curl-results.json`.
