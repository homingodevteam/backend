#!/usr/bin/env bash
# Module 5 · Dispatch engine, end to end against a running API.
#
# Proves the thing module 4 could not do on its own: a booking assigns itself.
# Expects a migrated + seeded database, at least one approved Pro holding the
# service, the mock OTP provider, and APP_LOG pointing at the app's stdout.

BASE="${BASE:-http://127.0.0.1:53000/api/v1}"
APP_LOG="${APP_LOG:-.curl-test-runtime/app.out.log}"
PASS=0
FAIL=0
STATUS=""
BODY=""

ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

expect() {
  if [ "$STATUS" = "$2" ]; then ok "$1 ($STATUS)"; else bad "$1 (want $2, got $STATUS)" "$BODY"; fi
}

req() {
  local out
  if [ -n "${4:-}" ] && [ -n "${3:-}" ]; then
    out=$(curl -sS -X "$1" "$BASE$2" -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $4" -d "$3" -w $'\n%{http_code}')
  elif [ -n "${4:-}" ]; then
    out=$(curl -sS -X "$1" "$BASE$2" -H "Authorization: Bearer $4" -w $'\n%{http_code}')
  elif [ -n "${3:-}" ]; then
    out=$(curl -sS -X "$1" "$BASE$2" -H 'Content-Type: application/json' \
      -d "$3" -w $'\n%{http_code}')
  else
    out=$(curl -sS -X "$1" "$BASE$2" -w $'\n%{http_code}')
  fi
  STATUS=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

jq_() {
  printf '%s' "$BODY" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        let v = JSON.parse(s);
        for (const k of process.argv[1].split(".")) v = v == null ? v : v[k];
        process.stdout.write(v == null ? "" : String(v));
      } catch { process.stdout.write(""); }
    });' "$1"
}

login() {
  req POST /auth/otp/request "{\"phone\":\"$1\",\"actorType\":\"$2\"}"
  local ref code
  ref=$(jq_ data.providerRef)
  code=$(grep -oE "> [0-9]{6} \(ref $ref\)" "$APP_LOG" | tail -1 | grep -oE '[0-9]{6}' | head -1)
  req POST /auth/otp/verify \
    "{\"phone\":\"$1\",\"actorType\":\"$2\",\"providerRef\":\"$ref\",\"code\":\"$code\"}"
  jq_ data.accessToken
}

echo "=== module 5 · dispatch engine ==="

CUST=$(login "${CUSTOMER_PHONE:-+919876500022}" customer)
if [ -n "$CUST" ]; then ok "customer login"; else bad "customer login" "$BODY"; fi
ADMIN=$(login '+916266941709' admin)
if [ -n "$ADMIN" ]; then ok "admin login"; else bad "admin login" "$BODY"; fi

req GET /catalog/services
SVC=$(jq_ data.0.id)

req POST /customers/me/addresses \
  '{"label":"home","addressLine":"9 Vijay Nagar","pinLat":22.7196,"pinLng":75.8577}' "$CUST"
ADDR=$(jq_ data.id)
if [ -n "$ADDR" ]; then ok "address created"; else bad "address" "$BODY"; fi

echo "--- intake ---"
req POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"cash\"}" "$CUST"
expect "create cash booking" 201
BK=$(jq_ data.id)

req GET /admin/dispatch/queue '' "$ADMIN"
DEPTH=$(jq_ data.depth)
if [ "${DEPTH:-0}" -ge 1 ]; then
  ok "booking was queued for dispatch (depth $DEPTH)"
else
  bad "queue depth" "$BODY"
fi

echo "--- the engine ---"
req POST /admin/dispatch/drain '' "$ADMIN"
expect "drain the queue" 201
OUTCOME=$(jq_ data.0.outcome)
WINNER=$(jq_ data.0.assignedProId)
if [ "$OUTCOME" = "assigned" ]; then
  ok "booking assigned automatically (pro $WINNER)"
else
  bad "dispatch outcome" "$BODY"
fi

req GET "/bookings/$BK" '' "$CUST"
if [ "$(jq_ data.status)" = "assigned" ]; then ok "booking is now assigned"; else bad "status" "$BODY"; fi
if [ -n "$(jq_ data.ackDeadlineAt)" ]; then ok "acknowledgement window opened"; else bad "ack window" "$BODY"; fi

echo "--- explainability ---"
req GET "/admin/dispatch/bookings/$BK/candidates" '' "$ADMIN"
expect "candidate list" 200
if [ "$(jq_ data.0.isWinner)" = "true" ]; then ok "winner recorded"; else bad "winner" "$BODY"; fi
if [ -n "$(jq_ data.0.finalRankScore)" ]; then ok "score inputs persisted"; else bad "scores" "$BODY"; fi
if [ -n "$(jq_ data.0.originType)" ]; then ok "travel origin recorded ($(jq_ data.0.originType))"; else bad "origin" "$BODY"; fi
if [ -n "$(jq_ data.0.ratingScore)" ]; then ok "smoothed rating recorded ($(jq_ data.0.ratingScore))"; else bad "rating" "$BODY"; fi

echo "--- acknowledgement ---"
PRO=$(login "${PRO_PHONE:-+919000000001}" pro)
req POST "/pros/me/bookings/$BK/acknowledge" '{}' "$PRO"
expect "Pro acknowledges" 201
req POST "/pros/me/bookings/$BK/acknowledge" '{}' "$PRO"
expect "acknowledging twice is not an error" 201

req GET "/bookings/$BK" '' "$CUST"
if [ -n "$(jq_ data.acknowledgedAt)" ]; then ok "acknowledgedAt stamped"; else bad "acknowledgedAt" "$BODY"; fi

echo "--- no accept, no decline ---"
req POST "/pros/me/bookings/$BK/accept" '{}' "$PRO"
expect "there is no accept route" 404
req POST "/pros/me/bookings/$BK/decline" '{}' "$PRO"
expect "there is no decline route" 404

echo
printf 'passed: %s   failed: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
