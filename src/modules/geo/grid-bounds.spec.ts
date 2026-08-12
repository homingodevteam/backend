import { centreIsInside, generateGridForBounds } from './geo.types';

/** Google's own box for Indore: 24.6 km north-south, 20.1 km east-west. */
const INDORE = {
  minLat: 22.6131,
  maxLat: 22.8349,
  minLng: 75.7657,
  maxLng: 75.962,
};

describe('generateGridForBounds', () => {
  it('covers the whole box', () => {
    const cells = generateGridForBounds({ ...INDORE, cellSizeKm: 2 });

    const south = Math.min(...cells.map((c) => c.minLat));
    const north = Math.max(...cells.map((c) => c.maxLat));
    const west = Math.min(...cells.map((c) => c.minLng));
    const east = Math.max(...cells.map((c) => c.maxLng));

    expect(south).toBeCloseTo(INDORE.minLat, 6);
    expect(west).toBeCloseTo(INDORE.minLng, 6);
    // Overshoot is allowed and clipping is not — see below.
    expect(north).toBeGreaterThanOrEqual(INDORE.maxLat);
    expect(east).toBeGreaterThanOrEqual(INDORE.maxLng);
  });

  /**
   * The rule that keeps a customer in town from being told we do not serve
   * their street: round outward, never inward. A hole at the city edge is
   * invisible until somebody falls in it.
   */
  it('overshoots the far edge rather than clipping it', () => {
    // 24.6 km at 7 km cells does not divide evenly.
    const cells = generateGridForBounds({ ...INDORE, cellSizeKm: 7 });
    const north = Math.max(...cells.map((c) => c.maxLat));

    expect(north).toBeGreaterThan(INDORE.maxLat);
  });

  /**
   * The whole reason the tiling is arithmetic rather than per-cell: half-open
   * bounds only work if one cell's max is bit-identical to its neighbour's
   * min. A gap of one float ULP is a pin that resolves to nothing.
   */
  it('tiles with no gap and no overlap', () => {
    const cells = generateGridForBounds({ ...INDORE, cellSizeKm: 3 });
    const cols = Math.max(...cells.map((c) => c.col)) + 1;

    for (const cell of cells) {
      const right = cells.find(
        (other) => other.row === cell.row && other.col === cell.col + 1,
      );
      if (right) expect(right.minLng).toBe(cell.maxLng);

      const above = cells.find(
        (other) => other.col === cell.col && other.row === cell.row + 1,
      );
      if (above) expect(above.minLat).toBe(cell.maxLat);
    }

    expect(cells).toHaveLength(
      cols * (Math.max(...cells.map((c) => c.row)) + 1),
    );
  });

  it('labels cells the way a spreadsheet does', () => {
    const cells = generateGridForBounds({ ...INDORE, cellSizeKm: 10 });

    expect(cells[0].name).toBe('A1');
    expect(cells.map((c) => c.name)).toContain('B2');
  });

  it('never returns nothing, even for a box smaller than one cell', () => {
    const tiny = {
      minLat: 22.72,
      maxLat: 22.7201,
      minLng: 75.9,
      maxLng: 75.9001,
    };

    expect(generateGridForBounds({ ...tiny, cellSizeKm: 5 })).toHaveLength(1);
  });

  /**
   * The point of taking a rectangle rather than a centre and a radius. A
   * square big enough to hold Indore wastes a fifth of its cells before
   * anybody deactivates one.
   */
  it('produces fewer cells than a square that contains the same city', () => {
    const fromBox = generateGridForBounds({ ...INDORE, cellSizeKm: 2 });

    // The equivalent square: half-width big enough for the longer axis.
    const squareSideCells = Math.ceil(24.6 / 2);
    const squareCells = squareSideCells * squareSideCells;

    expect(fromBox.length).toBeLessThan(squareCells);
  });
});

describe('centreIsInside', () => {
  const box = INDORE;
  const cell = (minLat: number, minLng: number) => ({
    minLat,
    maxLat: minLat + 0.02,
    minLng,
    maxLng: minLng + 0.02,
  });

  it('keeps a cell well inside', () => {
    expect(centreIsInside(cell(22.72, 75.85), box)).toBe(true);
  });

  it('drops a cell well outside', () => {
    expect(centreIsInside(cell(23.1, 75.85), box)).toBe(false);
  });

  /**
   * Judged by the centre, not by overlap. A cell half in and half out is
   * kept — erring inward leaves a hole at the city edge, and that surfaces as
   * "we do not serve your street" for somebody who lives in town.
   */
  it('keeps a cell straddling the boundary whose centre is inside', () => {
    // Centre at 22.8299, just south of the 22.8349 edge; top pokes out.
    expect(centreIsInside(cell(22.8199, 75.85), box)).toBe(true);
  });

  it('drops a cell straddling the boundary whose centre is outside', () => {
    // Centre at 22.8449, north of the edge.
    expect(centreIsInside(cell(22.8349, 75.85), box)).toBe(false);
  });

  it('checks longitude as well as latitude', () => {
    expect(centreIsInside(cell(22.72, 76.2), box)).toBe(false);
  });
});
