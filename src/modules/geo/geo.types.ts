/**
 * Great-circle distance in kilometres.
 *
 * The one distance function in the codebase. It lived in `dispatch.types.ts`
 * while module 13 did not exist — module 5's own comment said as much — and
 * `dispatch.types.ts` now re-exports it from here so nothing that imports it
 * had to change.
 *
 * **This no longer decides which area a pin is in.** Areas are rectangles,
 * resolved by an indexed range query. Haversine remains because dispatch ranks
 * candidates by how far they are from the job, which is a genuine distance
 * question.
 *
 * Straight-line, not road distance. Good enough to rank; not good enough to
 * quote an ETA, which is why nothing here publishes one yet.
 */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A point on the earth, as the client reports it. */
export interface Coordinates {
  lat: number;
  lng: number;
}

/** An axis-aligned lat/lng rectangle. Bounds are half-open — see below. */
export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * One degree of latitude, in kilometres. Effectively constant everywhere.
 *
 * The mean value; the true figure varies from ~110.6 km at the equator to
 * ~111.7 km at the poles because the earth is not a sphere. At city scale the
 * difference is under a percent — smaller than the error in eyeballing a
 * neighbourhood boundary off a map.
 */
export const KM_PER_DEGREE_LAT = 111.32;

/**
 * One degree of longitude, in kilometres, at a given latitude.
 *
 * Unlike latitude this genuinely varies: meridians converge toward the poles,
 * so a degree of longitude is ~111 km at the equator and zero at the pole. At
 * Indore's 22.7° it is ~103 km — an 8% difference from latitude, which is
 * small per cell and visible as skew across a whole city grid if ignored.
 */
export function kmPerDegreeLng(latitude: number): number {
  return KM_PER_DEGREE_LAT * Math.cos((latitude * Math.PI) / 180);
}

/**
 * Does this point fall inside this box?
 *
 * **Half-open on both axes:** `min <= value < max`. That asymmetry is the
 * whole reason a tiled grid resolves deterministically. Adjacent cells share
 * an edge exactly — cell A's `maxLat` *is* cell B's `minLat`, the same float,
 * because both came from the same arithmetic. With closed bounds a pin on that
 * edge belongs to both cells; with half-open bounds it belongs to exactly one.
 *
 * The consequence to know: the northern and eastern edges of the **outermost**
 * cells are not covered — a pin landing exactly on the grid's far boundary
 * resolves to nothing. That is accepted rather than padded around, for two
 * reasons: `generateGrid` rounds the extent **up** to a whole number of cells,
 * so that boundary already lies beyond the coverage that was asked for, and
 * hitting it needs exact float equality with a generated edge, which a real
 * GPS reading does not do. Verified against the database, not assumed.
 */
export function containsPoint(
  box: BoundingBox,
  lat: number,
  lng: number,
): boolean {
  return (
    lat >= box.minLat &&
    lat < box.maxLat &&
    lng >= box.minLng &&
    lng < box.maxLng
  );
}

/** Do two boxes share any area? Touching edges alone do not count. */
export function boxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.minLat < b.maxLat &&
    a.maxLat > b.minLat &&
    a.minLng < b.maxLng &&
    a.maxLng > b.minLng
  );
}

/**
 * Grow a box outward by a margin in kilometres.
 *
 * What makes "which areas neighbour this one" a two-line question rather than
 * an adjacency table: expand the box slightly and ask which others it now
 * overlaps. Cells that merely share an edge qualify; cells across town do not.
 *
 * The margin is applied in degrees per axis, so longitude is scaled by the
 * latitude — a kilometre east is more degrees than a kilometre north.
 */
export function expandBox(box: BoundingBox, marginKm: number): BoundingBox {
  const midLat = (box.minLat + box.maxLat) / 2;
  const dLat = marginKm / KM_PER_DEGREE_LAT;
  const dLng = marginKm / kmPerDegreeLng(midLat);

  return {
    minLat: box.minLat - dLat,
    maxLat: box.maxLat + dLat,
    minLng: box.minLng - dLng,
    maxLng: box.maxLng + dLng,
  };
}

/** Approximate area in square kilometres — used to break overlap ties. */
export function boxAreaSqKm(box: BoundingBox): number {
  const midLat = (box.minLat + box.maxLat) / 2;
  const heightKm = (box.maxLat - box.minLat) * KM_PER_DEGREE_LAT;
  const widthKm = (box.maxLng - box.minLng) * kmPerDegreeLng(midLat);
  return Math.abs(heightKm * widthKm);
}

/** Geometric centre. Derived, never stored — a rectangle already implies it. */
export function boxCenter(box: BoundingBox): Coordinates {
  return {
    lat: (box.minLat + box.maxLat) / 2,
    lng: (box.minLng + box.maxLng) / 2,
  };
}

/** Height and width in kilometres, for display. */
export function boxDimensionsKm(box: BoundingBox): {
  heightKm: number;
  widthKm: number;
} {
  const midLat = (box.minLat + box.maxLat) / 2;
  return {
    heightKm: Number(
      ((box.maxLat - box.minLat) * KM_PER_DEGREE_LAT).toFixed(2),
    ),
    widthKm: Number(
      ((box.maxLng - box.minLng) * kmPerDegreeLng(midLat)).toFixed(2),
    ),
  };
}

export interface GeneratedCell extends BoundingBox {
  /** Grid position, e.g. `A1`. Ops renames the ones that matter. */
  name: string;
  row: number;
  col: number;
}

/**
 * Lay a gapless grid of cells over a city.
 *
 * This is the shape's payoff. Cells are generated from one arithmetic
 * progression per axis, so **adjacent cells share exact float boundaries** and
 * the grid tiles with no gaps and no overlap — by construction, not by
 * inspection. Nothing needs to sample for holes afterwards.
 *
 * Cells are named by grid position (`A1`, `B3`) rather than anything
 * geographic, because the generator has no idea what is on the ground. Ops
 * renames the ones that matter to "Vijay Nagar" and deactivates the ones that
 * fall in farmland or another district.
 *
 * @param centerLat  roughly the city centre
 * @param centerLng  roughly the city centre
 * @param extentKm   half-width — how far out from the centre to cover
 * @param cellSizeKm side length of one cell
 */
export function generateGrid(input: {
  centerLat: number;
  centerLng: number;
  extentKm: number;
  cellSizeKm: number;
}): GeneratedCell[] {
  const latStep = input.cellSizeKm / KM_PER_DEGREE_LAT;
  const lngStep = input.cellSizeKm / kmPerDegreeLng(input.centerLat);

  // Rounded up so the requested extent is always fully covered rather than
  // clipped to the nearest whole cell.
  const half = Math.ceil(input.extentKm / input.cellSizeKm);
  const rows = half * 2;
  const cols = half * 2;

  const originLat = input.centerLat - half * latStep;
  const originLng = input.centerLng - half * lngStep;

  const cells: GeneratedCell[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        name: `${rowLabel(row)}${col + 1}`,
        row,
        col,
        // Each boundary is computed once from the origin, so cell (r, c)'s
        // maxLat is bit-identical to cell (r+1, c)'s minLat. That identity is
        // what half-open bounds rely on.
        minLat: originLat + row * latStep,
        maxLat: originLat + (row + 1) * latStep,
        minLng: originLng + col * lngStep,
        maxLng: originLng + (col + 1) * lngStep,
      });
    }
  }

  return cells;
}

/**
 * The same tiling, from a **rectangle** instead of a centre and a radius.
 *
 * Cities are not square. Indore is about 25 km north-south and 20 east-west,
 * so a square big enough to contain it wastes a fifth of its cells on
 * farmland before anybody deactivates anything. Given a real bounding box —
 * from `GeocoderPort.geocodeCity`, or drawn by hand — this covers exactly that
 * box and no more.
 *
 * Identical guarantee to `generateGrid`: every boundary is computed once from
 * one origin per axis, so cell (r, c)'s `maxLat` is bit-identical to cell
 * (r+1, c)'s `minLat`. Half-open bounds depend on that identity, and it is why
 * a generated map cannot have a gap.
 *
 * The grid is grown **outward from the box's south-west corner** and rounded
 * up, so the far edges may overshoot by less than one cell. Overshooting is
 * the safe direction: a pin just outside the box still resolves, where
 * clipping would leave a hole that only shows up as a customer being told we
 * do not serve their street.
 */
export function generateGridForBounds(input: {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  cellSizeKm: number;
}): GeneratedCell[] {
  const midLat = (input.minLat + input.maxLat) / 2;
  const latStep = input.cellSizeKm / KM_PER_DEGREE_LAT;
  const lngStep = input.cellSizeKm / kmPerDegreeLng(midLat);

  const rows = Math.max(1, Math.ceil((input.maxLat - input.minLat) / latStep));
  const cols = Math.max(1, Math.ceil((input.maxLng - input.minLng) / lngStep));

  const originLat = input.minLat;
  const originLng = input.minLng;

  const cells: GeneratedCell[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        name: `${rowLabel(row)}${col + 1}`,
        row,
        col,
        minLat: originLat + row * latStep,
        maxLat: originLat + (row + 1) * latStep,
        minLng: originLng + col * lngStep,
        maxLng: originLng + (col + 1) * lngStep,
      });
    }
  }

  return cells;
}

/** Is this cell's centre inside the box? The test bulk deactivation uses. */
export function centreIsInside(
  cell: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  box: { minLat: number; maxLat: number; minLng: number; maxLng: number },
): boolean {
  const lat = (cell.minLat + cell.maxLat) / 2;
  const lng = (cell.minLng + cell.maxLng) / 2;
  return (
    lat >= box.minLat &&
    lat <= box.maxLat &&
    lng >= box.minLng &&
    lng <= box.maxLng
  );
}

/** 0 → A, 25 → Z, 26 → AA. Spreadsheet convention, because ops reads it. */
function rowLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * The shape every area resolution returns. `null` from a resolver means the
 * pin fell outside every active area — a real answer, not a missing one.
 */
export interface ResolvedArea {
  areaId: string;
  areaName: string;
  cityId: string;
  cityName: string;
}

export interface ServiceabilityResult {
  serviceable: boolean;
  area: ResolvedArea | null;
  /** Safe to show a customer. Present only when `serviceable` is false. */
  reason?: string;
  code?: string;
}

/** Platform setting keys this module owns. */
export const GEO_SETTINGS = {
  defaultCellSizeKm: 'geo.defaultCellSizeKm',
  enforceAreaServiceAvailability: 'geo.enforceAreaServiceAvailability',
} as const;

/**
 * Rejects a coordinate that is out of range, or `NaN` — which is what
 * `Number(undefined)` produces and what a mis-parsed query string yields.
 * A NaN pin matches no box, which reads as "we don't serve you" rather than
 * "your request was malformed".
 */
export function isValidCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}
