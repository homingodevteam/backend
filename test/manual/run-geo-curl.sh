#!/usr/bin/env bash
#
# Module 13 · Service areas — HTTP smoke test.
#
# Unit tests mock Prisma and the swagger spec proves the contract; neither
# proves the module answers correctly over the wire against a real database.
# This does, and it is the check that found the model behaves as designed on a
# shared cell boundary — the one case the whole geometry rests on.
#
# Assumes:
#   - migrations applied and `npm run db:seed` run (four tiled Indore areas,
#     with the deep clean deliberately OFF in Rau)
#   - the app listening on $BASE
#
#   ./test/manual/run-geo-curl.sh [base-url]
#
# Exits non-zero on the first failed expectation.

set -uo pipefail

BASE="${1:-http://localhost:3000/api/v1}"
PASS=0
FAIL=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n     expected %s, got %s\n' "$1" "$2" "$3"; FAIL=$((FAIL + 1)); }

# `jq` is not assumed — this repo's other manual scripts do not require it.
json() { python -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null || echo "__ERR__"; }

expect_eq() {
  local label="$1" actual="$2" wanted="$3"
  [ "$actual" = "$wanted" ] && pass "$label" || fail "$label" "$wanted" "$actual"
}

status_of() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

echo
echo "Geo · service areas — $BASE"
echo

# ---------------------------------------------------------------------------
echo "Resolution"
# ---------------------------------------------------------------------------
for probe in "22.74:75.89:Vijay Nagar" "22.74:75.83:Rajwada" \
             "22.69:75.89:Palasia" "22.69:75.83:Rau"; do
  IFS=: read -r lat lng want <<< "$probe"
  got=$(curl -s "$BASE/geo/serviceability?lat=$lat&lng=$lng" | json "['data']['area']['areaName']")
  expect_eq "($lat, $lng) resolves to $want" "$got" "$want"
done

got=$(curl -s "$BASE/geo/serviceability?lat=23.2599&lng=77.4126" | json "['data']['code']")
expect_eq "Bhopal is outside every area" "$got" "LOCATION_NOT_SERVICEABLE"

# ---------------------------------------------------------------------------
echo
echo "Half-open bounds — the model's load-bearing detail"
# ---------------------------------------------------------------------------
# 22.714 is the exact seam between Palasia (below) and Vijay Nagar (above).
# It must belong to the UPPER cell, and to exactly one of them.
got=$(curl -s "$BASE/geo/serviceability?lat=22.714&lng=75.89" | json "['data']['area']['areaName']")
expect_eq "a pin ON the seam belongs to the upper cell" "$got" "Vijay Nagar"

got=$(curl -s "$BASE/geo/serviceability?lat=22.71399&lng=75.89" | json "['data']['area']['areaName']")
expect_eq "a hair below the seam belongs to the lower cell" "$got" "Palasia"

# ---------------------------------------------------------------------------
echo
echo "Location catalogue — the app's first screen"
# ---------------------------------------------------------------------------
DEEP='Full Home Deep Cleaning (2 BHK)'
avail_of() {
  curl -s "$BASE/geo/catalog?lat=$1&lng=$2" \
    | json "['data']['services']" \
    | python -c "
import sys, ast
services = ast.literal_eval(sys.stdin.read())
match = [s for s in services if s['name'] == '''$DEEP''']
print(str(match[0]['isAvailable']) if match else '__MISSING__')
" 2>/dev/null || echo "__ERR__"
}

expect_eq "deep clean IS available in Vijay Nagar" "$(avail_of 22.74 75.89)" "True"
expect_eq "deep clean is NOT available in Rau"     "$(avail_of 22.69 75.83)" "False"

# Unavailable services are returned and flagged, never hidden — a thinly
# mapped area must not look like an empty product.
vn=$(curl -s "$BASE/geo/catalog?lat=22.74&lng=75.89" | json "['data']['services'].__len__()")
rau=$(curl -s "$BASE/geo/catalog?lat=22.69&lng=75.83" | json "['data']['services'].__len__()")
expect_eq "Rau lists the same services as Vijay Nagar, just flagged" "$rau" "$vn"

out=$(curl -s "$BASE/geo/catalog?lat=23.2599&lng=77.4126" | json "['data']['services'].__len__()")
[ "$out" = "$vn" ] \
  && pass "an out-of-coverage pin still returns the catalogue to browse" \
  || fail "an out-of-coverage pin still returns the catalogue to browse" "$vn" "$out"

# ---------------------------------------------------------------------------
echo
echo "The client never names its own area"
# ---------------------------------------------------------------------------
expect_eq "a malformed coordinate is a 400, not 'unserviceable'" \
  "$(status_of "$BASE/geo/serviceability?lat=abc&lng=75.89")" "400"
expect_eq "an out-of-range coordinate is a 400" \
  "$(status_of "$BASE/geo/serviceability?lat=999&lng=75.89")" "400"
expect_eq "admin area routes reject an unauthenticated caller" \
  "$(status_of "$BASE/admin/areas?cityId=00000000-0000-4000-9000-000000000001")" "401"

# ---------------------------------------------------------------------------
echo
printf 'passed %d, failed %d\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
