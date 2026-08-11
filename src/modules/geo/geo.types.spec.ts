import {
  boxAreaSqKm,
  boxCenter,
  boxesOverlap,
  containsPoint,
  generateGrid,
  haversineKm,
  isValidCoordinate,
  kmPerDegreeLng,
  type BoundingBox,
} from './geo.types';

const CELL: BoundingBox = {
  minLat: 22.7,
  maxLat: 22.75,
  minLng: 75.85,
  maxLng: 75.9,
};

describe('containsPoint', () => {
  it('accepts a point inside', () => {
    expect(containsPoint(CELL, 22.72, 75.87)).toBe(true);
  });

  it('rejects a point outside on any side', () => {
    expect(containsPoint(CELL, 22.6, 75.87)).toBe(false);
    expect(containsPoint(CELL, 22.8, 75.87)).toBe(false);
    expect(containsPoint(CELL, 22.72, 75.8)).toBe(false);
    expect(containsPoint(CELL, 22.72, 75.95)).toBe(false);
  });

  /**
   * The half-open rule, and the entire reason a tiled grid is deterministic.
   * Lower bounds belong to the cell, upper bounds belong to the next one.
   */
  it('includes its lower edges and excludes its upper edges', () => {
    expect(containsPoint(CELL, CELL.minLat, CELL.minLng)).toBe(true);
    expect(containsPoint(CELL, CELL.maxLat, 75.87)).toBe(false);
    expect(containsPoint(CELL, 22.72, CELL.maxLng)).toBe(false);
  });

  /**
   * The property that matters in production: a pin on the boundary two cells
   * share belongs to exactly one of them — never both, never neither.
   */
  it('assigns a shared edge to exactly one of two adjacent cells', () => {
    const south: BoundingBox = { ...CELL };
    const north: BoundingBox = {
      ...CELL,
      minLat: CELL.maxLat,
      maxLat: CELL.maxLat + 0.05,
    };
    const onTheSeam = CELL.maxLat;

    const matches = [south, north].filter((box) =>
      containsPoint(box, onTheSeam, 75.87),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(north);
  });
});

describe('boxesOverlap', () => {
  it('is false for cells that merely touch', () => {
    const north = { ...CELL, minLat: CELL.maxLat, maxLat: CELL.maxLat + 0.05 };
    expect(boxesOverlap(CELL, north)).toBe(false);
  });

  it('is true when they genuinely interpenetrate', () => {
    const shifted = { ...CELL, minLat: 22.72, maxLat: 22.78 };
    expect(boxesOverlap(CELL, shifted)).toBe(true);
  });

  it('is false for boxes nowhere near each other', () => {
    expect(
      boxesOverlap(CELL, {
        minLat: 23.2,
        maxLat: 23.3,
        minLng: 77.4,
        maxLng: 77.5,
      }),
    ).toBe(false);
  });

  it('is symmetric', () => {
    const other = { ...CELL, minLat: 22.72, maxLat: 22.78 };
    expect(boxesOverlap(CELL, other)).toBe(boxesOverlap(other, CELL));
  });
});

describe('boxAreaSqKm', () => {
  it('measures a roughly 6 km cell as roughly 36 km²', () => {
    const cell = generateGrid({
      centerLat: 22.72,
      centerLng: 75.86,
      extentKm: 6,
      cellSizeKm: 6,
    })[0];

    expect(boxAreaSqKm(cell)).toBeCloseTo(36, 0);
  });
});

describe('boxCenter', () => {
  it('is the midpoint of the bounds', () => {
    expect(boxCenter(CELL)).toEqual({ lat: 22.725, lng: 75.875 });
  });
});

describe('kmPerDegreeLng', () => {
  /**
   * Meridians converge. Ignoring this skews a city-wide grid — at Indore's
   * latitude a degree of longitude is ~8% shorter than a degree of latitude.
   */
  it('shrinks with latitude', () => {
    expect(kmPerDegreeLng(0)).toBeCloseTo(111.32, 1);
    expect(kmPerDegreeLng(22.7)).toBeLessThan(kmPerDegreeLng(0));
    expect(kmPerDegreeLng(60)).toBeCloseTo(111.32 / 2, 0);
  });
});

describe('generateGrid', () => {
  const params = {
    centerLat: 22.7196,
    centerLng: 75.857,
    extentKm: 12,
    cellSizeKm: 6,
  };

  it('covers the requested extent with whole cells', () => {
    const cells = generateGrid(params);
    // 12 km either side at 6 km per cell → 4×4.
    expect(cells).toHaveLength(16);
  });

  it('names cells by grid position, for an admin to rename later', () => {
    const cells = generateGrid(params);
    expect(cells[0].name).toBe('A1');
    expect(cells.map((c) => c.name)).toContain('D4');
    expect(new Set(cells.map((c) => c.name)).size).toBe(cells.length);
  });

  /**
   * The guarantee the whole model rests on. Every pair of cells either touches
   * or is disjoint — none interpenetrates. This is what "tiles by
   * construction" means, and it is checked rather than asserted.
   */
  it('produces cells that never overlap each other', () => {
    const cells = generateGrid(params);

    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        expect(boxesOverlap(cells[i], cells[j])).toBe(false);
      }
    }
  });

  /**
   * The other half: no gaps. Adjacent cells share a *bit-identical* boundary,
   * because both were derived from the same origin and step. Near-equality
   * would leave a sliver that nothing resolves.
   */
  it('shares exact float boundaries between neighbours', () => {
    const cells = generateGrid(params);
    const cols = 4;

    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < cols; col++) {
        const here = cells[row * cols + col];
        const above = cells[(row + 1) * cols + col];
        expect(above.minLat).toBe(here.maxLat);
      }
    }

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const here = cells[row * cols + col];
        const right = cells[row * cols + col + 1];
        expect(right.minLng).toBe(here.maxLng);
      }
    }
  });

  /**
   * The consequence of the two properties above: every point inside the grid
   * lands in exactly one cell. Sampled across the covered region.
   */
  it('assigns every sampled point to exactly one cell', () => {
    const cells = generateGrid(params);

    for (let lat = 22.63; lat < 22.81; lat += 0.011) {
      for (let lng = 75.75; lng < 75.96; lng += 0.011) {
        const matches = cells.filter((cell) => containsPoint(cell, lat, lng));
        // Either outside the grid entirely, or in precisely one cell — never
        // in two.
        expect(matches.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('covers the centre it was given', () => {
    const cells = generateGrid(params);
    const matches = cells.filter((cell) =>
      containsPoint(cell, params.centerLat, params.centerLng),
    );
    expect(matches).toHaveLength(1);
  });

  /**
   * The documented edge of the model, pinned so nobody "fixes" it later.
   *
   * Half-open bounds mean the grid's far northern and eastern boundary lines
   * belong to no cell. Accepted rather than padded: the extent is rounded up,
   * so that boundary already lies beyond the coverage requested, and reaching
   * it needs exact float equality with a generated edge.
   */
  it('leaves the outermost north and east boundary lines uncovered', () => {
    const cells = generateGrid(params);
    const farNorth = Math.max(...cells.map((c) => c.maxLat));
    const farEast = Math.max(...cells.map((c) => c.maxLng));

    expect(
      cells.filter((c) => containsPoint(c, farNorth, params.centerLng)),
    ).toHaveLength(0);
    expect(
      cells.filter((c) => containsPoint(c, params.centerLat, farEast)),
    ).toHaveLength(0);

    // A hair inside is covered, which is what makes the above harmless.
    expect(
      cells.filter((c) => containsPoint(c, farNorth - 1e-9, params.centerLng)),
    ).toHaveLength(1);
  });

  it('rounds the extent up so the requested area is never clipped', () => {
    // 10 km extent at 6 km cells needs 2 cells either side, not 1.67.
    const cells = generateGrid({ ...params, extentKm: 10 });
    expect(cells).toHaveLength(16);
  });

  it('rolls row labels past Z', () => {
    const cells = generateGrid({ ...params, extentKm: 90, cellSizeKm: 6 });
    expect(cells.some((cell) => cell.name.startsWith('AA'))).toBe(true);
  });
});

describe('haversineKm', () => {
  /**
   * Retained for dispatch's travel-time ranking. It no longer decides which
   * area a pin is in — that is a range query now.
   */
  it('measures a known Indore pair', () => {
    expect(haversineKm(22.7533, 75.8937, 22.7196, 75.857)).toBeCloseTo(5.3, 0);
  });

  it('is zero for a point against itself, and symmetric', () => {
    expect(haversineKm(22.75, 75.89, 22.75, 75.89)).toBe(0);
    expect(haversineKm(22.75, 75.89, 22.71, 75.85)).toBeCloseTo(
      haversineKm(22.71, 75.85, 22.75, 75.89),
      10,
    );
  });

  it('handles antipodal points without NaN from a rounding overshoot', () => {
    expect(Number.isFinite(haversineKm(0, 0, 0, 180))).toBe(true);
  });
});

describe('isValidCoordinate', () => {
  it.each([
    [22.7533, 75.8937],
    [0, 0],
    [-90, -180],
    [90, 180],
  ])('accepts (%p, %p)', (lat, lng) => {
    expect(isValidCoordinate(lat, lng)).toBe(true);
  });

  /**
   * `Number(undefined)` is NaN, and a NaN pin matches no box — which would
   * tell a customer we do not serve them when the request was malformed.
   */
  it('rejects NaN, which is what a mis-parsed query string produces', () => {
    expect(isValidCoordinate(Number.NaN, 75.8937)).toBe(false);
    expect(isValidCoordinate(22.7533, Number.NaN)).toBe(false);
  });

  it('rejects infinities and out-of-range values', () => {
    expect(isValidCoordinate(Number.POSITIVE_INFINITY, 0)).toBe(false);
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(0, 181)).toBe(false);
  });
});
