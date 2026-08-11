# Module 13 — Geo & Routing · Instalment 1: Service Areas

**Date:** 2026-08-11
**Status:** ✅ **Built.** Conflicts #42–44 recorded.

Written against the service-area brief, [`ERD_DATA_MODEL_V10.md`](ERD_DATA_MODEL_V10.md),
and [`CONFLICTS_AND_DECISIONS.md`](CONFLICTS_AND_DECISIONS.md) #8, #11 and #19.

> This is the first of two instalments. It builds the **map** — what an area is,
> what is available in it, who works in it, and how a pin becomes one. Google
> Maps, Places, Routes, ETA and live tracking over WebSockets are the second,
> and nothing here presumes their shape beyond keeping the seam open.

---

## 1 · The gap this closes

Before it, "can this customer book this service" had exactly one answer:
`City.isActive`. Conflict #8 settled that deliberately, and it was right at the
time — but it means a city is open or shut and every service in it is equally
available everywhere in it.

"AC repair in Vijay Nagar but not Rau" was not hard to express. It was
**impossible**. That is the whole gap.

---

## 2 · What an area is

An axis-aligned **rectangle**: `minLat`, `maxLat`, `minLng`, `maxLng`.

> Built as circles first — the brief specified centre + `radiusKm` + haversine
> — then changed. Conflict #42 records why in full; the short version is below.

### Rectangles tile; circles cannot

The brief also asked that areas "should ideally not overlap", and that is
impossible with circles: lay disjoint circles over a city and you get
wedge-shaped gaps between them where real customers live. The circle build
managed that — overlap on purpose, resolve by nearest centre, sample for gaps —
and it worked, but all of it was machinery for a problem the shape created.

A grid of rectangles has no such problem:

| Property           | Consequence                                                        |
| ------------------ | ------------------------------------------------------------------ |
| Tiles exactly      | No gaps and no overlap **by construction** — nothing to sample for |
| Indexed resolution | Four range comparisons the database answers from a btree, no trig  |
| Deterministic      | Half-open bounds put an edge pin in exactly one cell               |
| Stable             | Row order never changes the answer                                 |

### Half-open bounds, and why they matter

`minLat <= lat < maxLat AND minLng <= lng < maxLng`.

The asymmetry is the load-bearing detail. Adjacent cells share an edge
_exactly_ — one cell's `maxLat` is **bit-identical** to its neighbour's
`minLat`, because the generator derives both from the same origin and step.
With closed bounds, a pin on that seam matches two cells. With half-open
bounds it matches precisely one. A spec sweeps points across a generated grid
and asserts at most one match, so this cannot silently regress.

### When two areas do match

A generated grid never produces two. Hand-drawn ones can — usefully, where a
small precise box sits inside a larger fallback. **Smallest box wins** (the
most specific answer), with the id as a final tiebreak so the result is stable
rather than merely usually-stable.

`GET /admin/areas/:id/overlaps` now reads as a **warning** and should be empty;
anything in it means a hand-edit broke the partition. Touching edges are not
overlap — adjacent cells share them by design.

### Why not PostGIS

It buys nothing yet and costs an extension dependency. The entire geometry
question lives in **one function**, `LocationService.resolveArea` — which is
exactly why swapping circles for rectangles touched nothing outside this
module, and why a `geography(Polygon)` column can replace rectangles later on
the same terms.

---

## 3 · Schema

| Table             | Purpose                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `areas`           | The rectangle. Half-open bounds on both axes                        |
| `area_services`   | **Availability only.** Price stays national; no per-area price rows |
| `pro_areas`       | Where a Pro is posted. A filter on dispatch, never the ranking      |
| `bookings.areaId` | Frozen at creation, like `flatPrice` — areas get redrawn            |

Three CHECK constraints worth naming: latitude and longitude are range-checked
(a swapped lat/lng for Indore is a _valid-looking_ pair that lands in the
Arabian Sea), and bounds must be **strictly** ordered — a degenerate box with
zero height satisfies `min <= max`, looks entirely correct, and silently
matches nothing forever.

**No `customer_addresses.areaId`** — see #42. It would be a cache nothing
maintains.

### Settings

| Key                                  | Default | Scope         |
| ------------------------------------ | ------- | ------------- |
| `geo.defaultCellSizeKm`              | `6`     | global        |
| `geo.enforceAreaServiceAvailability` | `false` | global + city |

---

## 4 · The enforcement flag is the important part

This is the first rule in the codebase whose only possible effect is to **refuse
a booking that would previously have succeeded**. Shipping it enabled would
reject every booking in every city on deploy — not because it is wrong, but
because no areas are drawn, so nothing resolves, so a perfectly working check
fails everything.

So it ships **off, per city**, while still resolving and recording the area and
logging every would-be rejection.

```
ship off → ops maps a city → read what the gate WOULD have refused
        → flip that city to true → the gate is real there and nowhere else
```

That turns switching it on from a leap into a measurement. Conflict #43.

---

## 5 · API surface

| Method  | Route                            | Actor  | Note                                              |
| ------- | -------------------------------- | ------ | ------------------------------------------------- |
| `GET`   | `/geo/catalog`                   | public | **The app's first screen** — what can I book here |
| `GET`   | `/geo/serviceability`            | public | Pin in, answer out. **Never** takes an areaId     |
| `GET`   | `/geo/services/:id/areas`        | public | "We are available in…"                            |
| `POST`  | `/admin/areas/generate-grid`     | admin  | **Open a city.** Gapless by construction          |
| `POST`  | `/admin/areas`                   | admin  | One rectangle by hand. `catalog.city.manage`      |
| `POST`  | `/admin/areas/bulk`              | admin  | Several by hand. All-or-nothing                   |
| `GET`   | `/admin/areas`                   | admin  |                                                   |
| `PATCH` | `/admin/areas/:id`               | admin  | Rename / deactivate / re-bound                    |
| `GET`   | `/admin/areas/service-matrix`    | admin  | Areas × services, at a glance                     |
| `GET`   | `/admin/areas/:id/overlaps`      | admin  | **Should be empty** — a hand-edit broke tiling    |
| `GET`   | `/admin/areas/:id/services`      | admin  |                                                   |
| `POST`  | `/admin/areas/:id/services`      | admin  | One service. Upsert — re-enabling is fine         |
| `PUT`   | `/admin/areas/:id/services`      | admin  | **The whole list, declaratively.** One txn        |
| `POST`  | `/admin/areas/:id/services/copy` | admin  | Clone another area's availability                 |
| `POST`  | `/admin/areas/by-service/:id`    | admin  | One service across many areas                     |
| `POST`  | `/admin/areas/:id/pros`          | admin  | `pro.availability.set`                            |
| `GET`   | `/admin/areas/:id/pros`          | admin  |                                                   |

### The funnel runs the right way round

`GET /geo/catalog?lat&lng` exists because every other check here answers "can I
book **this** service here" one service at a time — which is the wrong end of
the funnel to ask from. Without it, a customer in Rau browses the national
catalogue, picks the deep clean, fills in a booking, and only then meets
`SERVICE_NOT_AVAILABLE_IN_AREA`. The check was right; its position was not.

Unavailable services are **returned and flagged, not hidden**. Two reasons: a
thinly-mapped area would otherwise look like an empty product rather than a new
one, and "customers in Rau kept opening the deep clean" is the demand signal
that tells ops where to expand — which vanishes if the row never reaches the
client. A pin outside every area returns the catalogue with everything
unavailable rather than an error; the customer is still allowed to look.

### Why four ways to set availability, not one

Each matches a decision someone actually makes, and collapsing them would mean
expressing a single decision as N calls:

| Shape                    | The decision it matches                    |
| ------------------------ | ------------------------------------------ |
| `POST :id/services`      | "Turn the deep clean off in Rau"           |
| `PUT :id/services`       | An admin screen saving its whole state     |
| `POST :id/services/copy` | "Palasia offers what Vijay Nagar offers"   |
| `POST by-service/:id`    | "We now do AC repair everywhere in Indore" |

`PUT` is the one an admin UI should call on save. The incremental alternative
makes the screen diff its own state against the server and fire a call per
service — and a failure halfway leaves the area in a state neither the admin
nor the server intended.

Rows are **deactivated, never deleted**. `isActive: false` and "no row" resolve
identically for a customer, but the row records that someone considered this
service here and said no, which a deletion erases. The matrix surfaces the
difference as `isConfigured`.

The customer endpoints are unauthenticated on purpose: someone must be able to
find out whether we serve their address before creating an account, and neither
answer discloses anything a competitor could not get by dropping a pin.

**Neither accepts an `areaId`.** The client sends a pin; the server decides. That
direction is the entire security model — a client that could name its own area
could book a service anywhere.

---

## 5b · How an admin actually sets a city up (the MVP)

There is no map UI yet, and there does not need to be one to open a city. Four
steps, ordered so the **only irreversible-feeling one is last**.

**1 · Lay the grid.** One call. Ops needs a rough city centre — right-click in
Google Maps, the first context-menu item is the lat/lng, click to copy.

```
POST /admin/areas/generate-grid
{ "cityId": "…", "centerLat": 22.7196, "centerLng": 75.857,
  "extentKm": 15, "cellSizeKm": 6 }
→ 36 cells named A1…F6, tiling a 30 km square with no gaps
```

Nothing to check afterwards. The cells cannot overlap and cannot leave holes —
that is what the shape is for.

**2 · Let the system work out what the cells are.**

```
POST /admin/areas/suggest-names?cityId=…
→ { queued: 36, running: true }        returns immediately
```

The generator names cells `A1`…`F6` because it has no idea what is on the
ground. Without this step an admin's only way to find out was to copy four
coordinates into Google Maps, **thirty-six times per city** — which is not a
workflow, it is the step where somebody mislabels a cell and discovers it when
bookings go to the wrong Pros.

So each cell's centre is reverse-geocoded and a name **suggested**. It runs in
the background because the geocoder honours Nominatim's one-request-per-second
policy — 36 cells is over half a minute, too long to hold a request open. Poll
`GET /admin/areas/naming-progress`, or just re-read the list and watch the
names fill in.

Every area also now carries its **centre, its size in kilometres and a Google
Maps link**, so a cell the geocoder could not name is still one click from
being identified rather than four coordinates to transcribe.

**3 · Review and trim.** Suggestions are suggestions:

```
PATCH /admin/areas/{C3}  { "name": "Vijay Nagar" }   → nameSource: manual
PATCH /admin/areas/{F6}  { "isActive": false }
```

`nameSource` tells you what still needs attention — `generated` is an
unreviewed placeholder, `geocoded` a suggestion nobody has confirmed, `manual`
a decision somebody made. **The naming pass only ever overwrites `generated`**,
so it is safe to re-run and safe to run while someone is halfway through
renaming.

Deactivating is how you shape a square grid to a non-square city. A pin in a
deactivated cell resolves to nothing, which is the honest answer.

**3 · Say what is available.** Set one area up properly, then copy it:

```
PUT  /admin/areas/{vijay-nagar}/services   { "serviceIds": ["…", "…"] }
POST /admin/areas/{palasia}/services/copy  { "sourceAreaId": "{vijay-nagar}" }
```

Then check the whole city at once with `GET /admin/areas/service-matrix`, which
shows every area against every live service — including the ones nobody has
decided about yet (`isConfigured: false`).

**4 · Only now, turn the gate on.** Set `geo.enforceAreaServiceAvailability` to
`true` for that city. Until this point the map has been recording without
rejecting anything, so the logs already show what it _would_ have refused.

Steps 1–3 are safe to get wrong; step 4 is the only one that can turn a
customer away. See #43.

> **Two Indore-sized sanity numbers.** Indore is roughly 25 km across, so
> `extentKm: 15` with `cellSizeKm: 6` gives a 5×5-ish grid — around 25–36
> cells, and you will deactivate a good third of them. And the cell size is a
> parameter, not a constant: a dense centre and a sparse outskirt do not have
> to be mapped at the same resolution, though the generator does one size at a
> time.

### Where hand-drawn rectangles still fit

`POST /admin/areas` and `/admin/areas/bulk` take explicit bounds, for a city
whose real boundaries do not suit a uniform grid. The trade is that
hand-drawn rectangles **can** leave gaps and **can** overlap, which is why the
generator is the default path and `/overlaps` exists to catch the mistake.

> **Two Indore-sized sanity numbers.** Indore is roughly 25 km across, so at a
> 6 km radius it wants **6–10 circles**, not 50. And `radiusKm` is per area:
> a dense centre and a sparse outskirt should not be the same size, which is
> exactly why it is a column and not a constant.

---

## 6 · How it plugs in

`SERVICEABILITY_PORT`, owned by module 4, registered by `GeoModule` at boot —
the third use of the delegate pattern after dispatch (#32) and payments. Module
4 asks "may this booking happen here, and where is here?" and never learns what
a circle is.

Dispatch takes `ProArea` as a **filter parameter**, alongside module 7's cash
ceiling. `null` means _do not filter_ and is deliberately distinct from `[]`:
nobody posted to an area is a configuration gap, and applying an empty list
would exclude every Pro in the city and report it as a supply gap (#31's
distinction, in a new place).

`haversineKm` moved here from `dispatch.types.ts`, which only ever held it
because this module did not exist — `TravelTimePort`'s own comment said so.
`dispatch.types.ts` re-exports it, so nothing that imported it changed.

---

## 7 · What is deliberately not here

| Not built                                   | Why                                                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forward geocoding (typed address → lat/lng) | Only _reverse_ exists. Google Places on the frontend already returns coordinates, so the server never parses an address. Revisit for a plain text box or a non-Google client                       |
| Google Maps / Places                        | Instalment 2. Reverse geocoding is still module 2's Nominatim adapter — a **swap** with a per-call bill, not an addition                                                                           |
| Routes / ETA                                | Instalment 2. `TravelTimePort` still resolves to haversine, and module 4's tracking publishes a null ETA rather than a number nobody can stand behind                                              |
| WebSockets                                  | Instalment 2, and the largest item in it: socket auth (the JWT guards are HTTP-only), a Fastify WS adapter, and Redis pub/sub once there is more than one instance. Tracking is a polled GET today |
| Pro schedules                               | Dispatch still has no roster; `Pro.isAvailable` is a straight on/off flag. Genuinely new scope, not a gap                                                                                          |
| PostGIS polygons                            | One function to replace when rectangles stop being enough                                                                                                                                          |

---

## 8 · Definition of done

- [x] A generated grid provably never overlaps itself — every pair checked, not asserted
- [x] Adjacent cells share **bit-identical** boundaries, so no sliver falls between them
- [x] A pin swept across a grid matches **at most one** cell, edges included
- [x] A pin on a shared seam belongs to exactly one of the two cells, never both or neither
- [x] Resolution is one indexed range query — no area is loaded to be measured
- [x] Resolution is order-independent, with the id as a final tiebreak so it cannot flicker
- [x] Two hand-drawn matches resolve to the **smallest** box — the most specific answer
- [x] A pin in no cell returns `null` rather than being attached to the nearest one
- [x] A NaN or out-of-range coordinate is a **400 about the request**, never "we do not serve you"
- [x] An inverted or degenerate rectangle is refused in code **and** by a CHECK constraint
- [x] "We are not here" and "we are here but not for that" are different codes with different messages
- [x] Booking re-resolves from the pin and freezes `areaId`; it never trusts a client-supplied area
- [x] The gate ships off, records the area anyway, and logs what it would have refused
- [x] Dispatch treats area posting as a filter; `null` means no filter, not "exclude everyone"
- [x] Nine booking states, Redis GEO and the `Pro` naming all survive unchanged (#44)

**Gate:** typecheck and `lint --max-warnings=0` clean, **445 unit tests** (72
new) and 130 e2e passing, app boots with all 17 geo routes mapped.
