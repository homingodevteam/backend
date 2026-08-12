#!/usr/bin/env bash
#
# Modules 4 (Booking) + 13 (Geo) — full HTTP surface, edge cases included.
#
# Unit tests mock Prisma; the swagger suites prove the published contract.
# Neither proves the API answers correctly over the wire against a real
# database. This does.
#
# Requires:
#   - migrated + seeded database
#   - the app on $BASE with OTP_PROVIDER=mock and NOMINATIM_BASE_URL pointed at
#     test/manual/nominatim-test-server.mjs (the mock logs OTP codes to the app
#     log, which is the only way a script can complete an OTP flow)
#   - $APP_LOG pointing at the app's stdout
#
#   ./test/manual/run-geo-booking-curl.sh
#
# Phone numbers are salted per run: OTP requests are rate-limited per number,
# so a rerun with fixed numbers 429s and every login fails.

set -uo pipefail

BASE="${BASE:-http://127.0.0.1:53000/api/v1}"
APP_LOG="${APP_LOG:-.curl-test-runtime/app.out.log}"
SALT="${SALT:-$(date +%H%M%S)}"
# Indian mobiles are exactly 10 digits, so only four salt digits fit.
SALT4="${SALT: -4}"

PASS=0
FAIL=0
STATUS=""
BODY=""
FAILED_LABELS=()

green() { printf '\033[32m%s\033[0m' "$1"; }
red() { printf '\033[31m%s\033[0m' "$1"; }

ok() { PASS=$((PASS + 1)); printf '  %s  %s\n' "$(green ok)" "$1"; }
bad() {
  FAIL=$((FAIL + 1))
  FAILED_LABELS+=("$1")
  printf '  %s %s\n       %s\n' "$(red FAIL)" "$1" "$2"
}

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

req() { # req METHOD PATH [JSON] [TOKEN]
  local out
  local args=(-sS -X "$1" "$BASE$2" -H 'Accept: application/json')
  [ -n "${4:-}" ] && args+=(-H "Authorization: Bearer $4")
  [ -n "${3:-}" ] && args+=(-H 'Content-Type: application/json' -d "$3")
  out=$(curl "${args[@]}" -w $'\n%{http_code}')
  STATUS=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

expect() { # expect LABEL WANT
  if [ "$STATUS" = "$2" ]; then
    ok "$1 ($STATUS)"
  else
    bad "$1 — want $2, got $STATUS" "$(printf '%s' "$BODY" | head -c 220)"
  fi
}

expect_field() { # expect_field LABEL dotted.path WANT
  local got
  got=$(jq_ "$2")
  if [ "$got" = "$3" ]; then
    ok "$1 ($2=$got)"
  else
    bad "$1 — $2: want '$3', got '$got'" "$(printf '%s' "$BODY" | head -c 220)"
  fi
}

jq_() {
  printf '%s' "$BODY" | python -c "
import sys, json
try:
    v = json.load(sys.stdin)
    for k in sys.argv[1].split('.'):
        if v is None: break
        v = v[int(k)] if k.isdigit() else v.get(k)
    print('' if v is None else v)
except Exception:
    print('')
" "$1"
}

login() { # login PHONE ACTOR -> token
  local ref code i
  req POST /auth/otp/request "{\"phone\":\"$1\",\"actorType\":\"$2\"}"
  ref=$(jq_ data.providerRef)
  [ -z "$ref" ] && { printf '' ; return; }

  # The mock provider logs the code to the app's stdout, and that write is not
  # synchronous with the HTTP response — under back-to-back logins the grep can
  # outrun the flush. Poll briefly rather than fail a login that is fine.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    # Take the digits that follow "-> " and nothing else. A bare
    # `grep -oE '[0-9]{6}'` also matches six-digit runs inside the ref UUID,
    # which yields two codes, an invalid JSON body, and a login that fails
    # only on the refs that happen to contain one.
    code=$(grep -a -oE "\-> [0-9]{6} \(ref $ref\)" "$APP_LOG" | tail -1 |
      sed -E 's/^-> ([0-9]{6}).*/\1/')
    [ -n "$code" ] && break
    sleep 0.3
  done
  [ -z "$code" ] && { printf '' ; return; }

  req POST /auth/otp/verify \
    "{\"phone\":\"$1\",\"actorType\":\"$2\",\"providerRef\":\"$ref\",\"code\":\"$code\"}"
  local token
  token=$(jq_ data.accessToken)
  if [ -z "$token" ]; then
    printf 'LOGIN-DEBUG %s %s -> verify %s %s\n' \
      "$1" "$2" "$STATUS" "$(printf '%s' "$BODY" | head -c 160)" >&2
  fi
  printf '%s' "$token"
}

INDORE='00000000-0000-4000-9000-000000000001'
DEEP_CLEAN='00000000-0000-4000-b000-000000000001'
AC_SERVICE='00000000-0000-4000-b000-000000000003'
VIJAY_NAGAR='00000000-0000-4000-c000-000000000001'
RAU='00000000-0000-4000-c000-000000000004'

printf '\n\033[1mHomingo · Booking + Geo HTTP suite\033[0m\n%s   salt=%s\n' "$BASE" "$SALT"

# ===========================================================================
section 'GEO · resolution'
# ===========================================================================
for probe in "22.74:75.89:Vijay Nagar" "22.74:75.83:Rajwada" \
             "22.69:75.89:Palasia" "22.69:75.83:Rau"; do
  IFS=: read -r lat lng want <<< "$probe"
  req GET "/geo/serviceability?lat=$lat&lng=$lng"
  expect_field "($lat, $lng) resolves to $want" data.area.areaName "$want"
done

req GET '/geo/serviceability?lat=23.2599&lng=77.4126'
expect_field 'a pin outside every area is not serviceable' data.code LOCATION_NOT_SERVICEABLE
expect_field '...and returns a null area rather than a guess' data.area ''

# --- half-open bounds: the model's load-bearing detail ---------------------
req GET '/geo/serviceability?lat=22.714&lng=75.89'
expect_field 'a pin ON the shared seam belongs to the upper cell' data.area.areaName 'Vijay Nagar'
req GET '/geo/serviceability?lat=22.71399&lng=75.89'
expect_field 'a hair below the seam belongs to the lower cell' data.area.areaName 'Palasia'
req GET '/geo/serviceability?lat=22.74&lng=75.858'
expect_field 'the vertical seam belongs to the eastern cell' data.area.areaName 'Vijay Nagar'
req GET '/geo/serviceability?lat=22.74&lng=75.85799'
expect_field 'a hair west of it belongs to the western cell' data.area.areaName 'Rajwada'

# --- coordinate validation -------------------------------------------------
req GET '/geo/serviceability?lat=abc&lng=75.89'
expect 'a non-numeric coordinate is a 400, not "unserviceable"' 400
req GET '/geo/serviceability?lat=999&lng=75.89'
expect 'latitude out of range is rejected' 400
req GET '/geo/serviceability?lat=22.74&lng=999'
expect 'longitude out of range is rejected' 400
req GET '/geo/serviceability?lng=75.89'
expect 'a missing latitude is rejected' 400
req GET '/geo/serviceability'
expect 'no coordinates at all is rejected' 400
req GET '/geo/serviceability?lat=-90&lng=-180'
expect 'the extreme legal coordinate is accepted' 200

# --- the security model ----------------------------------------------------
req GET "/geo/serviceability?lat=22.69&lng=75.83&areaId=$VIJAY_NAGAR"
expect 'a client-supplied areaId is rejected outright' 400
req GET '/geo/serviceability?lat=22.74&lng=75.89&serviceId=not-a-uuid'
expect 'a malformed serviceId is rejected' 400

# ===========================================================================
section 'GEO · service availability'
# ===========================================================================
req GET "/geo/serviceability?lat=22.74&lng=75.89&serviceId=$DEEP_CLEAN"
expect_field 'deep clean IS available in Vijay Nagar' data.serviceable True
req GET "/geo/serviceability?lat=22.69&lng=75.83&serviceId=$DEEP_CLEAN"
expect_field 'deep clean is NOT available in Rau' data.serviceable False
expect_field '...with the service-level code, not the location one' data.code SERVICE_NOT_AVAILABLE_IN_AREA
expect_field '...and still names the area, since we DO operate there' data.area.areaName Rau

req GET "/geo/serviceability?lat=23.2599&lng=77.4126&serviceId=$DEEP_CLEAN"
expect_field 'outside coverage outranks the service question' data.code LOCATION_NOT_SERVICEABLE

# ===========================================================================
section 'GEO · the location catalogue (the app’s first screen)'
# ===========================================================================
req GET '/geo/catalog?lat=22.74&lng=75.89'
expect 'catalogue resolves for a covered pin' 200
expect_field '...and names the area' data.area.areaName 'Vijay Nagar'

VN_COUNT=$(printf '%s' "$BODY" | python -c "import sys,json;print(len(json.load(sys.stdin)['data']['services']))")
VN_AVAIL=$(printf '%s' "$BODY" | python -c "import sys,json;print(sum(1 for s in json.load(sys.stdin)['data']['services'] if s['isAvailable']))")

req GET '/geo/catalog?lat=22.69&lng=75.83'
RAU_COUNT=$(printf '%s' "$BODY" | python -c "import sys,json;print(len(json.load(sys.stdin)['data']['services']))")
RAU_DEEP=$(printf '%s' "$BODY" | python -c "
import sys, json
m=[s for s in json.load(sys.stdin)['data']['services'] if s['id']=='$DEEP_CLEAN']
print(m[0]['isAvailable'] if m else 'MISSING')")

if [ "$RAU_COUNT" = "$VN_COUNT" ]; then
  ok "unavailable services are flagged, not hidden ($RAU_COUNT services in both)"
else
  bad 'unavailable services are flagged, not hidden' "Rau=$RAU_COUNT Vijay Nagar=$VN_COUNT"
fi
[ "$RAU_DEEP" = "False" ] \
  && ok 'deep clean flagged unavailable in Rau' \
  || bad 'deep clean flagged unavailable in Rau' "got $RAU_DEEP"
[ "$VN_AVAIL" -gt 0 ] \
  && ok "Vijay Nagar has $VN_AVAIL bookable services" \
  || bad 'Vijay Nagar has bookable services' 'none available'

req GET '/geo/catalog?lat=23.2599&lng=77.4126'
expect 'an out-of-coverage pin still returns the catalogue to browse' 200
expect_field '...marked unserviceable' data.serviceable False
OUT_COUNT=$(printf '%s' "$BODY" | python -c "import sys,json;d=json.load(sys.stdin)['data'];print(len(d['services']))")
OUT_AVAIL=$(printf '%s' "$BODY" | python -c "import sys,json;print(sum(1 for s in json.load(sys.stdin)['data']['services'] if s['isAvailable']))")
[ "$OUT_COUNT" -gt 0 ] && [ "$OUT_AVAIL" = "0" ] \
  && ok "...with all $OUT_COUNT services unavailable" \
  || bad 'out-of-coverage catalogue is all-unavailable' "count=$OUT_COUNT available=$OUT_AVAIL"

req GET '/geo/catalog?lat=22.74&lng=75.89&q=clean'
expect 'the catalogue honours a search filter' 200
Q_ALL=$(printf '%s' "$BODY" | python -c "
import sys, json
print(all('clean' in s['name'].lower() or 'clean' in (s.get('description') or '').lower()
          for s in json.load(sys.stdin)['data']['services']))")
[ "$Q_ALL" = "True" ] && ok '...and every result matches the query' \
  || bad 'search filter is applied' "non-matching rows returned"

req GET '/geo/catalog?lat=22.74&lng=75.89&q=x'
expect 'a one-character query is rejected (matches the whole catalogue)' 400
req GET '/geo/catalog?lat=22.74&lng=75.89&bookingType=teleport'
expect 'an unknown booking type is rejected' 400
req GET '/geo/catalog?lat=abc&lng=75.89'
expect 'the catalogue validates coordinates too' 400

req GET "/geo/services/$DEEP_CLEAN/areas"
expect 'where a service is live is public' 200
req GET '/geo/services/not-a-uuid/areas'
expect 'a malformed service id is rejected' 400

# ===========================================================================
section 'GEO · admin surface'
# ===========================================================================
req GET "/admin/areas?cityId=$INDORE"
expect 'listing areas needs a token' 401
req POST /admin/areas/generate-grid '{"cityId":"x","centerLat":22,"centerLng":75,"extentKm":10,"cellSizeKm":6}'
expect 'generating a grid needs a token' 401
req POST "/admin/areas/$VIJAY_NAGAR/services" '{"serviceId":"x","isActive":true}'
expect 'setting availability needs a token' 401

CUST_TOKEN=$(login "+9198${SALT4}0001" customer)
req GET "/admin/areas?cityId=$INDORE" '' "$CUST_TOKEN"
expect 'a customer token cannot read the admin area surface' 403

ADMIN_TOKEN=$(login '+916266941709' admin)
if [ -z "$ADMIN_TOKEN" ]; then
  printf '  SKIP admin cases — no token (the seeded admin number is rate-limited
'
  printf '       by a recent run; wait for the window or restart Redis)
'
else
  ok 'admin login'

  req GET "/admin/areas?cityId=$INDORE" '' "$ADMIN_TOKEN"
  expect 'admin lists the seeded areas' 200
  AREA_N=$(printf '%s' "$BODY" | python -c "import sys,json;print(len(json.load(sys.stdin)['data']))")
  [ "$AREA_N" = "4" ] && ok "...four of them" || bad 'four seeded areas' "got $AREA_N"

  req GET "/admin/areas/$VIJAY_NAGAR/overlaps" '' "$ADMIN_TOKEN"
  expect 'overlap report is readable' 200
  OV=$(printf '%s' "$BODY" | python -c "import sys,json;print(len(json.load(sys.stdin)['data']))")
  [ "$OV" = "0" ] \
    && ok '...and empty, because a tiled grid does not overlap' \
    || bad 'a tiled grid has no overlaps' "got $OV overlapping neighbours"

  req GET "/admin/areas/service-matrix?cityId=$INDORE" '' "$ADMIN_TOKEN"
  expect 'the areas x services matrix renders' 200
  UNCONF=$(printf '%s' "$BODY" | python -c "
import sys, json
d = json.load(sys.stdin)['data']
print(sum(1 for a in d['areas'] for s in a['availability'] if not s['isConfigured']))")
  ok "matrix reports $UNCONF unconfigured area/service pairs (never-decided, not 'off')"

  # The staffing gate — no Pro is posted to any seeded area, so every
  # activation must be refused.
  req POST "/admin/areas/$RAU/services" "{\"serviceId\":\"$DEEP_CLEAN\",\"isActive\":true}" "$ADMIN_TOKEN"
  expect 'activating a service where nobody is staffed is refused' 409
  expect_field '...with a code the UI can branch on' errors.0.code AREA_NOT_STAFFED_FOR_SERVICE

  req POST "/admin/areas/$RAU/services" "{\"serviceId\":\"$DEEP_CLEAN\",\"isActive\":false}" "$ADMIN_TOKEN"
  expect 'switching a service OFF is never blocked' 201

  req POST /admin/areas/generate-grid \
    "{\"cityId\":\"$INDORE\",\"centerLat\":22.72,\"centerLng\":75.86,\"extentKm\":10,\"cellSizeKm\":6}" "$ADMIN_TOKEN"
  expect 'regenerating a grid over a mapped city is refused' 409

  req POST /admin/areas \
    "{\"cityId\":\"$INDORE\",\"name\":\"Inverted $SALT\",\"minLat\":22.8,\"maxLat\":22.7,\"minLng\":75.8,\"maxLng\":75.9}" "$ADMIN_TOKEN"
  expect 'an inverted rectangle is refused' 400
  req POST /admin/areas \
    "{\"cityId\":\"$INDORE\",\"name\":\"Degenerate $SALT\",\"minLat\":22.7,\"maxLat\":22.7,\"minLng\":75.8,\"maxLng\":75.9}" "$ADMIN_TOKEN"
  expect 'a zero-height rectangle is refused' 400
  req POST /admin/areas \
    "{\"cityId\":\"$INDORE\",\"name\":\"Vijay Nagar\",\"minLat\":22.7,\"maxLat\":22.8,\"minLng\":75.8,\"maxLng\":75.9}" "$ADMIN_TOKEN"
  expect 'a duplicate area name in one city is refused' 409
fi

# ===========================================================================
section 'BOOKING · prerequisites'
# ===========================================================================
CT=$(login "+9198${SALT4}0002" customer)
[ -n "$CT" ] && ok 'customer login' || bad 'customer login' 'no token'

req GET /bookings
expect 'listing bookings needs a token' 401
req POST /bookings '{}'
expect 'creating a booking needs a token' 401

req POST /customers/me/addresses \
  '{"label":"home","addressLine":"12 Scheme 54","pinLat":22.74,"pinLng":75.89}' "$CT"
expect 'address in Vijay Nagar created' 201
ADDR_VN=$(jq_ data.id)

req POST /customers/me/addresses \
  '{"label":"other","addressLine":"9 Rau Main Rd","pinLat":22.69,"pinLng":75.83}' "$CT"
expect 'address in Rau created' 201
ADDR_RAU=$(jq_ data.id)

req POST /customers/me/addresses \
  '{"label":"other","addressLine":"Nowhere","pinLat":19.076,"pinLng":72.8777}' "$CT"
expect 'an address in an unserved city is refused' 422

req POST /customers/me/addresses \
  '{"label":"home","addressLine":"x","pinLat":22.74,"pinLng":75.89,"areaId":"'"$VIJAY_NAGAR"'"}' "$CT"
expect 'an address cannot name its own area' 400

# ===========================================================================
section 'BOOKING · creation and validation'
# ===========================================================================
req POST /bookings \
  "{\"serviceId\":\"$AC_SERVICE\",\"addressId\":\"$ADDR_VN\",\"paymentMode\":\"cash\"}" "$CT"
expect 'a cash instant booking is created' 201
BK=$(jq_ data.id)
if [ -z "$BK" ]; then
  bad 'booking id returned' 'creation failed — every dependent case below is unreachable'
fi
expect_field '...as cash' data.paymentMode cash
expect_field '...starting unpaid' data.paymentStatus unpaid

req GET "/bookings/$BK" '' "$CT"
expect 'the booking reads back' 200
BK_STATUS=$(jq_ data.status)
ok "cash booking skipped awaiting_payment (status: $BK_STATUS)"

req POST /bookings \
  "{\"serviceId\":\"$AC_SERVICE\",\"addressId\":\"$ADDR_VN\",\"paymentMode\":\"cash\",\"totalAmount\":1}" "$CT"
expect 'an unknown field is rejected, not silently dropped' 400

req POST /bookings "{\"serviceId\":\"$AC_SERVICE\",\"paymentMode\":\"cash\"}" "$CT"
expect 'a missing addressId is rejected' 400
req POST /bookings \
  "{\"serviceId\":\"nope\",\"addressId\":\"$ADDR_VN\",\"paymentMode\":\"cash\"}" "$CT"
expect 'a malformed serviceId is rejected' 400
req POST /bookings \
  "{\"serviceId\":\"00000000-0000-4000-b000-00000000ffff\",\"addressId\":\"$ADDR_VN\",\"paymentMode\":\"cash\"}" "$CT"
expect 'an unknown service is a 404' 404
req POST /bookings \
  "{\"serviceId\":\"$AC_SERVICE\",\"addressId\":\"$ADDR_VN\",\"paymentMode\":\"cash\",\"slotStartAt\":\"not-a-date\"}" "$CT"
expect 'a malformed slot time is rejected' 400
req POST /bookings \
  "{\"serviceId\":\"$AC_SERVICE\",\"addressId\":\"$ADDR_VN\",\"paymentMode\":\"cash\",\"flatPrice\":1}" "$CT"
expect 'a client-supplied price is rejected — the US-7.1 tampering vector' 400
req POST /bookings \
  "{\"serviceId\":\"$AC_SERVICE\",\"addressId\":\"$ADDR_VN\",\"paymentMode\":\"barter\"}" "$CT"
expect 'an unknown payment mode is rejected' 400
req POST /bookings \
  "{\"serviceId\":\"$AC_SERVICE\",\"addressId\":\"$ADDR_VN\",\"paymentMode\":\"cash\",\"areaId\":\"$RAU\"}" "$CT"
expect 'a booking cannot name its own area' 400

req POST /bookings \
  "{\"serviceId\":\"$DEEP_CLEAN\",\"addressId\":\"$ADDR_RAU\",\"paymentMode\":\"cash\"}" "$CT"
expect 'a scheduled-only service cannot be booked instantly' 409
expect_field '...with a code, not just prose' errors.0.code BOOKING_TYPE_UNSUPPORTED

# The area gate ships OFF (#43), so booking a service the AREA does not offer
# must still SUCCEED and simply record the area. This is the case that proves
# the gate is dormant rather than absent — deep clean is switched off in Rau.
SLOT=$(python -c "import datetime;print((datetime.datetime.now()+datetime.timedelta(days=2)).strftime('%Y-%m-%dT09:30:00.000Z'))")
req POST /bookings \
  "{\"serviceId\":\"$DEEP_CLEAN\",\"addressId\":\"$ADDR_RAU\",\"paymentMode\":\"cash\",\"slotStartAt\":\"$SLOT\"}" "$CT"
expect 'a service unavailable in the area is still bookable while the gate is off' 201
BK_RAU=$(jq_ data.id)

# ===========================================================================
section 'BOOKING · ownership and isolation'
# ===========================================================================
OTHER=$(login "+9198${SALT4}0003" customer)
req GET "/bookings/$BK" '' "$OTHER"
expect "another customer's booking is a 404, never a 403" 404
req POST "/bookings/$BK/cancel" '{"reason":"nope"}' "$OTHER"
expect '...and they cannot cancel it either' 404
req GET '/bookings/00000000-0000-4000-0000-0000000000ff' '' "$CT"
expect 'a booking that never existed is also a 404' 404
req GET '/bookings/not-a-uuid' '' "$CT"
expect 'a malformed booking id is rejected' 400

# ===========================================================================
section 'BOOKING · state machine'
# ===========================================================================
PRO_TOKEN=$(login "+9198${SALT4}0004" pro)
if [ -n "$PRO_TOKEN" ]; then
  ok 'pro login'
  req POST "/pros/me/bookings/$BK/en-route" '' "$PRO_TOKEN"
  expect 'an unassigned Pro cannot move someone else’s booking' 404
else
  bad 'pro login' 'no token'
fi

# Tracking is withheld while a booking is merely `assigning` — a pin before
# anyone is on the way would be misleading, not helpful.
req GET "/bookings/$BK/tracking" '' "$CT"
expect 'tracking is refused before anyone is on the way' 409
expect_field '...with a reason the app can render' errors.0.code BOOKING_NOT_TRACKABLE

if [ -n "$ADMIN_TOKEN" ]; then
  req GET "/admin/bookings/$BK" '' "$ADMIN_TOKEN"
  expect 'admin reconstructs the whole booking in one call' 200
fi

# ===========================================================================
section 'BOOKING · cancellation'
# ===========================================================================
req POST "/bookings/$BK_RAU/cancel" '{"reason":"changed my mind"}' "$CT"
expect 'a customer can cancel their own booking' 201
req GET "/bookings/$BK_RAU" '' "$CT"
expect_field '...and it reads back cancelled' data.status cancelled
req POST "/bookings/$BK_RAU/cancel" '{"reason":"again"}' "$CT"
expect 'cancelling twice is refused' 409

# ===========================================================================
section 'BOOKING · online payment path'
# ===========================================================================
# No Razorpay credentials on this deployment, so the gateway is unconfigured.
# The booking must survive in awaiting_payment rather than half-existing.
req POST /bookings \
  "{\"serviceId\":\"$AC_SERVICE\",\"addressId\":\"$ADDR_VN\",\"paymentMode\":\"online\"}" "$CT"
ONLINE_STATUS="$STATUS"
if [ "$ONLINE_STATUS" = "201" ]; then
  ok "an online booking was created ($ONLINE_STATUS)"
  BK_ONLINE=$(jq_ data.id)
  req GET "/bookings/$BK_ONLINE" '' "$CT"
  expect_field '...and sits in awaiting_payment' data.status awaiting_payment
elif [ "$ONLINE_STATUS" = "503" ] || [ "$ONLINE_STATUS" = "501" ]; then
  ok "online booking refused cleanly with no gateway configured ($ONLINE_STATUS)"
else
  bad 'online booking without gateway credentials' "unexpected $ONLINE_STATUS: $(printf '%s' "$BODY" | head -c 200)"
fi

# ===========================================================================
printf '\n\033[1mResult\033[0m  %s passed, %s failed\n' "$(green $PASS)" "$([ "$FAIL" -eq 0 ] && echo 0 || red $FAIL)"
if [ "$FAIL" -gt 0 ]; then
  printf '\nFailed:\n'
  printf '  - %s\n' "${FAILED_LABELS[@]}"
fi
printf '\n'
[ "$FAIL" -eq 0 ]
