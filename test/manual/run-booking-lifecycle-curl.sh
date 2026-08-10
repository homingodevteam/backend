#!/usr/bin/env bash
# Module 4 · cash-booking lifecycle, end to end against a running API.
#
# Drives the one path that is fully built today: create -> assign -> en route
# -> arrived -> start OTP -> started -> complete with photo -> invoice, plus
# the reconstruction and cancellation-window views.
#
# Expects: API on $BASE, a migrated + seeded database, the mock OTP provider,
# and APP_LOG pointing at the app's stdout (the mock logs codes there instead
# of sending an SMS — the only way a scripted run can complete an OTP flow).

BASE="${BASE:-http://127.0.0.1:53000/api/v1}"
APP_LOG="${APP_LOG:-.curl-test-runtime/app.out.log}"
PASS=0
FAIL=0
STATUS=""
BODY=""

ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }
skip() { printf 'SKIP  %s\n' "$1"; }

expect() { # expect <label> <want-status>
  if [ "$STATUS" = "$2" ]; then
    ok "$1 ($STATUS)"
  else
    bad "$1 (want $2, got $STATUS)" "$BODY"
  fi
}

req() { # req <METHOD> <PATH> [JSON] [TOKEN]
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

jq_() { # jq_ <dotted.path>  (reads $BODY)
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

login() { # login <phone> <actorType>  -> echoes token
  req POST /auth/otp/request "{\"phone\":\"$1\",\"actorType\":\"$2\"}"
  local ref code
  ref=$(jq_ data.providerRef)
  # Matched by providerRef so concurrent logins can't pick up each other's code.
  code=$(grep -oE "> [0-9]{6} \(ref $ref\)" "$APP_LOG" | tail -1 | grep -oE '[0-9]{6}' | head -1)
  req POST /auth/otp/verify \
    "{\"phone\":\"$1\",\"actorType\":\"$2\",\"providerRef\":\"$ref\",\"code\":\"$code\"}"
  jq_ data.accessToken
}

echo "=== module 4 · cash booking lifecycle ==="

CUST=$(login '+919876500011' customer)
if [ -n "$CUST" ]; then ok "customer OTP login"; else bad "customer OTP login" "$BODY"; fi

req GET /catalog/services
expect "browse catalogue unauthenticated" 200
SVC=$(jq_ data.0.id)

req POST /customers/me/addresses \
  '{"label":"home","addressLine":"12 MG Road","pinLat":22.7196,"pinLng":75.8577}' "$CUST"
ADDR=$(jq_ data.id)
if [ -n "$ADDR" ]; then ok "add address"; else bad "add address" "$BODY"; fi

echo "--- creation ---"
req POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"cash\"}" "$CUST"
expect "create cash booking" 201
BK=$(jq_ data.id)
if [ "$(jq_ data.status)" = "assigning" ]; then
  ok "cash skipped awaiting_payment -> assigning"
else
  bad "cash booking status" "$BODY"
fi
PRICE=$(jq_ data.flatPrice)
if [ -n "$PRICE" ]; then ok "price frozen from catalogue ($PRICE)"; else bad "price frozen" "$BODY"; fi
NUM=$(jq_ data.bookingNumber)
case "$NUM" in
  HB-*) ok "human-readable booking number ($NUM)" ;;
  *) bad "booking number" "$NUM" ;;
esac

req POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"online\"}" "$CUST"
expect "online booking refused while Payments is unbuilt" 501

echo "--- admin ---"
ADMIN=$(login '+916266941709' admin)
if [ -n "$ADMIN" ]; then ok "admin OTP login"; else bad "admin OTP login" "$BODY"; fi

req GET "/admin/bookings/$BK/cancellation-window" '' "$ADMIN"
if [ "$(jq_ data.window)" = "B" ]; then
  ok "unassigned booking is in window B"
else
  bad "cancellation window" "$BODY"
fi

if [ -z "${PRO_ID:-}" ]; then
  skip "Pro half — set PRO_ID/PRO_PHONE for an approved Pro to run assign -> complete"
else
  echo "--- assignment + Pro lifecycle ---"
  req POST "/admin/bookings/$BK/assign" "{\"proId\":\"$PRO_ID\"}" "$ADMIN"
  expect "admin assigns a Pro" 201

  PRO=$(login "${PRO_PHONE:-+919000000001}" pro)
  req POST "/pros/me/bookings/$BK/en-route" '{"lat":22.72,"lng":75.85}' "$PRO"
  expect "Pro marks en route" 201
  req POST "/pros/me/bookings/$BK/arrived" '{"lat":22.7196,"lng":75.8577}' "$PRO"
  expect "Pro marks arrival (start OTP issued)" 201

  req POST "/pros/me/bookings/$BK/complete" '{}' "$PRO"
  expect "completion refused before a verified start" 409

  req POST "/pros/me/bookings/$BK/verify-otp" '{"code":"000000"}' "$PRO"
  expect "wrong start code rejected" 400

  SCODE=$(grep -oE '> [0-9]{6} \(ref' "$APP_LOG" | tail -1 | grep -oE '[0-9]{6}')
  req POST "/pros/me/bookings/$BK/verify-otp" "{\"code\":\"$SCODE\"}" "$PRO"
  expect "verified start OTP starts the job" 201

  req POST "/pros/me/bookings/$BK/complete" '{}' "$PRO"
  expect "completion refused without a photo" 409

  req POST "/pros/me/bookings/$BK/photos/upload-url" \
    '{"photoType":"completion","contentType":"image/jpeg"}' "$PRO"
  KEY=$(jq_ data.photoKey)
  req POST "/pros/me/bookings/$BK/photos" \
    "{\"photoType\":\"completion\",\"photoKey\":\"$KEY\",\"lat\":22.7196,\"lng\":75.8577}" "$PRO"
  expect "attach geo-stamped completion photo" 201

  req POST "/pros/me/bookings/$BK/complete" '{"lat":22.7196,"lng":75.8577}' "$PRO"
  expect "complete the job" 201
  INV=$(jq_ data.invoiceNumber)
  if [ -n "$INV" ]; then ok "invoice generated ($INV)"; else bad "invoice" "$BODY"; fi
  DUR=$(jq_ data.actualDurationMinutes)
  if [ -n "$DUR" ]; then ok "actual duration computed ($DUR min)"; else bad "duration" "$BODY"; fi

  req POST "/bookings/$BK/cancel" '{"reason":"too late"}' "$CUST"
  expect "completed job cannot be cancelled" 409
fi

echo "--- reconstruction ---"
req GET "/admin/bookings/$BK" '' "$ADMIN"
expect "one-call dispute reconstruction" 200
if [ -n "$(jq_ data.statusEvents.0.status)" ]; then
  ok "timeline present in the same payload"
else
  bad "timeline" "$BODY"
fi

echo
printf 'passed: %s   failed: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
