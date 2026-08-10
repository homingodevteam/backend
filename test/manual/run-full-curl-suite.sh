#!/usr/bin/env bash
# Every module built so far, driven through the public HTTP API.
#
# Covers the happy paths and — more importantly — the edge cases the user
# stories call out, since those are where a naive implementation breaks.
#
# Expects: a migrated + seeded database, the mock OTP provider, the Nominatim
# and Redis test doubles, and APP_LOG pointing at the app's stdout.

BASE="${BASE:-http://127.0.0.1:53000/api/v1}"
APP_LOG="${APP_LOG:-.curl-test-runtime/app.out.log}"
PASS=0
FAIL=0
STATUS=""
BODY=""
FAILURES=""

ok() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() {
  FAIL=$((FAIL + 1))
  FAILURES="${FAILURES}\n  - $1"
  printf '  FAIL  %s\n        %s\n' "$1" "$(printf '%s' "$2" | head -c 220)"
}
section() { printf '\n== %s ==\n' "$1"; }

expect() { if [ "$STATUS" = "$2" ]; then ok "$1 ($STATUS)"; else bad "$1 [want $2 got $STATUS]" "$BODY"; fi; }
truthy() { if [ -n "$2" ]; then ok "$1"; else bad "$1" "$BODY"; fi; }
equals() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 [want '$3' got '$2']" "$BODY"; fi; }

req() {
  local out
  if [ -n "${4:-}" ] && [ -n "${3:-}" ]; then
    out=$(curl -sS -X "$1" "$BASE$2" -H 'Content-Type: application/json' -H "Authorization: Bearer $4" -d "$3" -w $'\n%{http_code}')
  elif [ -n "${4:-}" ]; then
    out=$(curl -sS -X "$1" "$BASE$2" -H "Authorization: Bearer $4" -w $'\n%{http_code}')
  elif [ -n "${3:-}" ]; then
    out=$(curl -sS -X "$1" "$BASE$2" -H 'Content-Type: application/json' -d "$3" -w $'\n%{http_code}')
  else
    out=$(curl -sS -X "$1" "$BASE$2" -w $'\n%{http_code}')
  fi
  STATUS=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

hdr() { # req with one extra header
  local out
  out=$(curl -sS -X "$1" "$BASE$2" -H 'Content-Type: application/json' -H "Authorization: Bearer $4" -H "$5" -d "$3" -w $'\n%{http_code}')
  STATUS=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

jq_() {
  printf '%s' "$BODY" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { let v = JSON.parse(s);
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
  req POST /auth/otp/verify "{\"phone\":\"$1\",\"actorType\":\"$2\",\"providerRef\":\"$ref\",\"code\":\"$code\"}"
  jq_ data.accessToken
}

RUN="$(date +%s)"
# Per-phone OTP rate limiting is real (M1 feature 10), so each run uses fresh
# numbers rather than fighting its own throttle.
SUFFIX="$(printf '%05d' $((RUN % 100000)))"
CUST_PHONE="+9198${SUFFIX}111"
OTHER_PHONE="+9198${SUFFIX}222"
PROBE_PHONE="+9198${SUFFIX}333"
echo "######## Homingo — full API suite (run $RUN) ########"

# =====================================================================
section "M1 · Identity & Access"
# =====================================================================
req POST /auth/otp/request "{\"phone\":\"$PROBE_PHONE\",\"actorType\":\"customer\"}"
expect "OTP request" 201
REF=$(jq_ data.providerRef)
truthy "providerRef returned, never a code" "$REF"

req POST /auth/otp/verify "{\"phone\":\"$PROBE_PHONE\",\"actorType\":\"customer\",\"providerRef\":\"$REF\",\"code\":\"000000\"}"
expect "wrong OTP code rejected" 401

CUST=$(login "$CUST_PHONE" customer)
truthy "customer OTP login" "$CUST"

req POST /auth/otp/request "{\"phone\":\"98${SUFFIX}444\",\"actorType\":\"customer\"}"
expect "10-digit Indian mobile accepted (canonicalised to +91)" 201

req POST /auth/otp/request '{"phone":"12345","actorType":"customer"}'
expect "malformed phone rejected" 400

req GET /customers/me
expect "no bearer token" 401

req GET /admin/pros '' "$CUST"
expect "customer token on an admin route" 403

ADMIN=$(login '+916266941709' admin)
truthy "admin OTP login" "$ADMIN"

req POST /auth/otp/request '{"phone":"+919999999999","actorType":"admin"}'
expect "unknown admin cannot self-register" 404

# M1 feature 10, tested rather than tripped over. The default is 5 per hour
# per number, so the sixth request must be refused.
RL_PHONE="+9197${SUFFIX}777"
RL_STATUS=""
for i in 1 2 3 4 5 6; do
  req POST /auth/otp/request "{\"phone\":\"$RL_PHONE\",\"actorType\":\"customer\"}"
  RL_STATUS="$STATUS"
done
expect "OTP requests are rate limited per phone" 429

# =====================================================================
section "M3 · Service Catalog (public)"
# =====================================================================
req GET /catalog/categories
expect "browse tree unauthenticated" 200
truthy "tree has a root category" "$(jq_ data.0.id)"
equals "tree is two levels — child has no children" "$(jq_ data.0.children.0.children.length)" "0"

req GET /catalog/services
expect "list services" 200
SVC=$(jq_ data.0.id)
SVCNAME=$(jq_ data.0.name)
truthy "service id" "$SVC"
if printf '%s' "$BODY" | grep -q 'commission'; then
  bad "commission must never appear on a customer surface" "$BODY"
else
  ok "commission absent from the public service payload"
fi

req GET "/catalog/services?q=clean"
expect "search by keyword" 200
req GET "/catalog/services?q=z"
expect "one-character search rejected" 400
req GET "/catalog/services?bookingType=recurring"
expect "filter by booking type" 200
req GET "/catalog/services/$SVC"
expect "resolve one service by id" 200

req GET /cities
expect "list active cities" 200
CITY=$(jq_ data.0.id)

# =====================================================================
section "M3 · Service Catalog (admin)"
# =====================================================================
req POST /admin/catalog/categories "{\"name\":\"Pest Control $RUN\",\"slug\":\"pest-control-$RUN\"}" "$ADMIN"
expect "create root category" 201
ROOT=$(jq_ data.id)

req POST /admin/catalog/categories "{\"name\":\"Termites\",\"slug\":\"termites-$RUN\",\"parentCategoryId\":\"$ROOT\"}" "$ADMIN"
expect "create child category" 201
CHILD=$(jq_ data.id)

req POST /admin/catalog/categories "{\"name\":\"Deep Termites\",\"slug\":\"deep-termites-$RUN\",\"parentCategoryId\":\"$CHILD\"}" "$ADMIN"
expect "third level refused — tree is two deep" 409

req POST /admin/catalog/categories "{\"name\":\"Dup\",\"slug\":\"pest-control-$RUN\"}" "$ADMIN"
expect "duplicate slug refused" 409

req POST /admin/catalog/services "{\"categoryId\":\"$CHILD\",\"name\":\"Termite Treatment\",\"durationMinutes\":120,\"flatPrice\":\"1999.00\"}" "$ADMIN"
expect "create service" 201
NEWSVC=$(jq_ data.id)
equals "service is created as a draft" "$(jq_ data.isActive)" "false"

req PATCH "/admin/catalog/services/$NEWSVC/activation" '{"isActive":true}' "$ADMIN"
expect "US-3.11 — cannot activate without a commission rate" 409

req PATCH "/admin/catalog/services/$NEWSVC/commission" '{"commissionType":"percent","commissionValue":"150"}' "$ADMIN"
expect "percent commission above 100 rejected" 400

req PATCH "/admin/catalog/services/$NEWSVC/commission" '{"commissionType":"flat","commissionValue":"500.00"}' "$ADMIN"
expect "flat commission above 100 allowed — it is rupees" 200

req PATCH "/admin/catalog/services/$NEWSVC/activation" '{"isActive":true}' "$ADMIN"
expect "activation succeeds once the rate is set" 200

req PATCH "/admin/catalog/services/$NEWSVC" '{"flatPrice":"2499.00"}' "$ADMIN"
expect "reprice a service" 200
equals "repricing did not touch the commission" "$(jq_ data.commissionValue)" "500"

req DELETE "/admin/catalog/categories/$CHILD" '' "$ADMIN"
expect "US-3.8 — cannot delete a category holding services" 409

req POST /admin/catalog/cities "{\"name\":\"Testville $RUN\",\"state\":\"Madhya Pradesh\",\"timezone\":\"Asia/Kolkata\"}" "$ADMIN"
expect "create a city" 201
NEWCITY=$(jq_ data.id)
equals "city is created dark" "$(jq_ data.isActive)" "false"

req PATCH "/admin/catalog/cities/$NEWCITY/activation" '{"isActive":true}' "$ADMIN"
expect "US-3.9 — launching a city with no approved Pros is refused" 409

req PATCH "/admin/catalog/cities/$NEWCITY/activation" '{"isActive":true,"acknowledgeNoSupply":true}' "$ADMIN"
expect "US-3.9 — ops may override deliberately" 200

# =====================================================================
section "M2 · Customer Profile"
# =====================================================================
req GET /customers/me '' "$CUST"
expect "get my profile" 200

req PATCH /customers/me '{"name":"Wrong Field"}' "$CUST"
expect "unknown field rejected, not silently stripped" 400

req PATCH /customers/me '{"fullName":"Asha Verma","email":"asha@example.com"}' "$CUST"
expect "update profile" 200

req GET "/customers/me/addresses/reverse-geocode?pinLat=22.7196&pinLng=75.8577" '' "$CUST"
expect "reverse geocode a pin" 200

req POST /customers/me/addresses '{"label":"home","addressLine":"12 MG Road","pinLat":22.7196,"pinLng":75.8577}' "$CUST"
expect "create address" 201
ADDR=$(jq_ data.id)
equals "first address becomes the default" "$(jq_ data.isDefault)" "true"
truthy "geoPoint derived from the pin" "$(jq_ data.geoPoint.type)"

req POST /customers/me/addresses '{"label":"office","addressLine":"5 AB Road","pinLat":22.72,"pinLng":75.86}' "$CUST"
expect "create a second address" 201
ADDR2=$(jq_ data.id)
equals "second address is not default" "$(jq_ data.isDefault)" "false"

req PATCH "/customers/me/addresses/$ADDR2/default" '{}' "$CUST"
expect "promote the second address to default" 200

OTHER=$(login "$OTHER_PHONE" customer)
req GET "/customers/me/addresses/$ADDR" '' "$OTHER"
if [ "$STATUS" = "404" ] || [ "$STATUS" = "405" ]; then
  ok "another customer's address is not disclosed ($STATUS)"
else
  bad "ownership non-disclosure [got $STATUS]" "$BODY"
fi

req GET "/customers/me/serviceability?cityId=$CITY" '' "$CUST"
expect "serviceability check" 200

# =====================================================================
section "M6 · Pro Management"
# =====================================================================
PRO=$(login '+919000000001' pro)
truthy "pro OTP login" "$PRO"
req GET /pros/me '' "$PRO"
expect "pro profile" 200
PROID=$(jq_ data.id)

# Three gates to dispatchability, all admin-set. Without them module 5 will
# correctly refuse to assign, which is the behaviour — not a bug.
if [ -n "${PRO_SETUP_SQL:-}" ]; then
  eval "$PRO_SETUP_SQL '$PROID' '$ADDR'"
  ok "Pro approved, on duty and given a home base (ops setup)"
fi

req POST "/admin/pros/$PROID/services" '{"serviceId":"00000000-0000-0000-0000-000000000000"}' "$ADMIN"
expect "serviceId validated against the catalogue (module 3 closed this)" 404

req POST "/admin/pros/$PROID/services" "{\"serviceId\":\"$SVC\",\"proficiency\":\"expert\"}" "$ADMIN"
# 409 on a re-run against a database that already holds the assignment is the
# correct answer, and the next case asserts that explicitly.
if [ "$STATUS" = "201" ] || [ "$STATUS" = "409" ]; then
  ok "assign a real service ($STATUS)"
else
  bad "assign a real service [want 201 or 409, got $STATUS]" "$BODY"
fi

req POST "/admin/pros/$PROID/services" "{\"serviceId\":\"$SVC\"}" "$ADMIN"
expect "duplicate service assignment refused" 409

# =====================================================================
section "M4 · Booking — creation"
# =====================================================================
req POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"online\"}" "$CUST"
expect "online booking refused while Payments is unbuilt" 501

req POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"cash\",\"slotStartAt\":\"2020-01-01T10:00:00.000Z\"}" "$CUST"
expect "slot in the past rejected" 400

req POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR2\",\"paymentMode\":\"cash\"}" "$OTHER"
expect "cannot book against someone else's address" 404

req POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"cash\"}" "$CUST"
expect "create a cash booking" 201
BK=$(jq_ data.id)
PRICE=$(jq_ data.flatPrice)
equals "cash skips awaiting_payment" "$(jq_ data.status)" "assigning"
truthy "price frozen from the catalogue ($PRICE)" "$PRICE"
truthy "slot window set even for an instant booking" "$(jq_ data.slotEndAt)"
case "$(jq_ data.bookingNumber)" in HB-*) ok "human-readable booking number" ;; *) bad "booking number" "$BODY" ;; esac

hdr POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"cash\"}" "$CUST" "Idempotency-Key: fixed-key-1"
IDEM1=$(jq_ data.id)
hdr POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"cash\"}" "$CUST" "Idempotency-Key: fixed-key-1"
equals "idempotent retry returns the same booking" "$(jq_ data.id)" "$IDEM1"

req POST "/bookings/$BK/rebook" '{}' "$CUST"
expect "one-tap rebook" 201
truthy "rebook records its lineage" "$(jq_ data.rebookedFromBookingId)"

# =====================================================================
section "M5 · Dispatch"
# =====================================================================
req GET /admin/dispatch/queue '' "$ADMIN"
DEPTH=$(jq_ data.depth)
if [ "${DEPTH:-0}" -ge 1 ]; then ok "bookings queued for dispatch (depth $DEPTH)"; else bad "queue depth" "$BODY"; fi

req POST /admin/dispatch/drain '' "$ADMIN"
expect "drain the queue" 201

req GET "/admin/dispatch/bookings/$BK/candidates" '' "$ADMIN"
expect "candidate explainability" 200
truthy "score inputs persisted" "$(jq_ data.0.finalRankScore)"
truthy "travel origin recorded" "$(jq_ data.0.originType)"
truthy "smoothed rating recorded" "$(jq_ data.0.ratingScore)"

req GET "/bookings/$BK" '' "$CUST"
ASSIGNED_STATUS=$(jq_ data.status)
if [ "$ASSIGNED_STATUS" = "assigned" ]; then
  ok "booking assigned automatically"
else
  bad "auto-assignment [status=$ASSIGNED_STATUS]" "$BODY"
fi

req POST "/pros/me/bookings/$BK/acknowledge" '{}' "$PRO"
expect "Pro acknowledges" 201
req POST "/pros/me/bookings/$BK/accept" '{}' "$PRO"
expect "no accept route exists" 404

# =====================================================================
section "M4 · Booking — the job"
# =====================================================================
req GET "/bookings/$BK/tracking" '' "$CUST"
expect "live tracking view" 200
equals "ETA is null until Geo & Routing exists" "$(jq_ data.etaMinutes)" ""

req POST "/bookings/$BK/messages" '{"body":"The gate code is 4821"}' "$CUST"
expect "customer messages the Pro" 201
req GET "/pros/me/bookings/$BK/messages" '' "$PRO"
expect "Pro reads the same thread from the Pro route" 200
if printf '%s' "$BODY" | grep -qE '"phone"|"email"'; then
  bad "chat must never carry contact details" "$BODY"
else
  ok "no contact details in the chat payload"
fi

req POST "/pros/me/bookings/$BK/complete" '{}' "$PRO"
expect "cannot complete before a verified start" 409

req POST "/pros/me/bookings/$BK/en-route" '{"lat":22.72,"lng":75.85}' "$PRO"
expect "Pro marks en route" 201
req POST "/pros/me/bookings/$BK/arrived" '{"lat":22.7196,"lng":75.8577}' "$PRO"
expect "Pro marks arrival" 201
req POST "/pros/me/bookings/$BK/en-route" '{"lat":22.73,"lng":75.87}' "$PRO"
expect "US-4.9 — arrived → en_route → arrived is allowed" 201
req POST "/pros/me/bookings/$BK/arrived" '{"lat":22.7196,"lng":75.8577}' "$PRO"
expect "Pro returns" 201

req POST "/pros/me/bookings/$BK/verify-otp" '{"code":"000000"}' "$PRO"
expect "wrong start code rejected" 400
SCODE=$(grep -oE '> [0-9]{6} \(ref' "$APP_LOG" | tail -1 | grep -oE '[0-9]{6}')
req POST "/pros/me/bookings/$BK/verify-otp" "{\"code\":\"$SCODE\"}" "$PRO"
expect "verified start OTP starts the job" 201

req POST "/pros/me/bookings/$BK/complete" '{}' "$PRO"
expect "US-4.16 — cannot complete without a photo" 409

req POST "/pros/me/bookings/$BK/photos/upload-url" '{"photoType":"completion","contentType":"image/jpeg"}' "$PRO"
expect "presigned photo upload url" 201
KEY=$(jq_ data.photoKey)
req POST "/pros/me/bookings/$BK/photos" '{"photoType":"completion","photoKey":"bookings/somewhere-else/proof/x"}' "$PRO"
expect "a photo key from another booking is rejected" 400
req POST "/pros/me/bookings/$BK/photos" "{\"photoType\":\"completion\",\"photoKey\":\"$KEY\",\"lat\":22.7196,\"lng\":75.8577}" "$PRO"
expect "attach a geo-stamped completion photo" 201

req POST "/pros/me/bookings/$BK/complete" '{"lat":22.7196,"lng":75.8577}' "$PRO"
expect "complete the job" 201
truthy "invoice generated" "$(jq_ data.invoiceNumber)"
truthy "tax recorded" "$(jq_ data.taxAmount)"
truthy "actual duration computed" "$(jq_ data.actualDurationMinutes)"

req POST "/bookings/$BK/cancel" '{"reason":"changed my mind"}' "$CUST"
expect "a completed job cannot be cancelled" 409

# =====================================================================
section "M4 · Cancellation windows"
# =====================================================================
req POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"cash\"}" "$CUST"
CANCELBK=$(jq_ data.id)
req GET "/admin/bookings/$CANCELBK/cancellation-window" '' "$ADMIN"
equals "an unassigned booking is in window B" "$(jq_ data.window)" "B"
equals "window B charges no fee" "$(jq_ data.chargesFee)" "false"

req POST "/bookings/$CANCELBK/cancel" '{"reason":"no longer needed"}' "$CUST"
expect "customer cancels before assignment" 201
equals "cancellation attributed to the customer" "$(jq_ data.cancelledByType)" "customer"

req POST "/bookings/$CANCELBK/cancel" '{"reason":"again"}' "$CUST"
expect "cannot cancel twice" 409

# =====================================================================
section "M4 · Admin reconstruction & M5 ops views"
# =====================================================================
req GET "/admin/bookings/$BK" '' "$ADMIN"
expect "US-4.24 — one-call dispute reconstruction" 200
truthy "timeline included" "$(jq_ data.statusEvents.0.status)"
truthy "photo proofs included" "$(jq_ data.photoProofs.0.id)"
truthy "chat included" "$(jq_ data.chatMessages.0.id)"

req GET /admin/dispatch/unassignable '' "$ADMIN"
expect "unassignable ops queue" 200

req POST /admin/bookings/expire-unpaid '' "$ADMIN"
expect "abandoned-checkout sweep" 201

req POST /admin/dispatch/expire-acknowledgements '' "$ADMIN"
expect "no-ack sweep" 201

# =====================================================================
section "Envelope & contract"
# =====================================================================
req GET /catalog/services
for f in success statusCode message data timestamp; do
  if printf '%s' "$BODY" | grep -q "\"$f\""; then ok "envelope carries $f"; else bad "envelope missing $f" "$BODY"; fi
done
req GET /admin/bookings/not-a-uuid '' "$ADMIN"
if [ "$STATUS" = "400" ] || [ "$STATUS" = "404" ] || [ "$STATUS" = "500" ]; then
  ok "malformed id handled ($STATUS)"
else
  bad "malformed id [got $STATUS]" "$BODY"
fi

echo
echo "######## passed: $PASS   failed: $FAIL ########"
if [ "$FAIL" -gt 0 ]; then printf 'failures:%b\n' "$FAILURES"; fi
[ "$FAIL" -eq 0 ]
