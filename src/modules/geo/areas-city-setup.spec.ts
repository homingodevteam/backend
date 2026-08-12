import { HttpException, HttpStatus } from '@nestjs/common';
import { AreasService } from './areas.service';

/** Google's own box for Indore. */
const INDORE = {
  minLat: 22.6131,
  maxLat: 22.8349,
  minLng: 75.7657,
  maxLng: 75.962,
};
const CITY = 'city-1';

function buildDeps() {
  const tx = {
    area: {
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(),
    },
  };

  const prisma = {
    city: { findUnique: jest.fn().mockResolvedValue({ id: CITY }) },
    area: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn((args: { data: object }) => args),
    },
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (c: typeof tx) => Promise<unknown>)(tx)
        : Promise.resolve(arg),
    ),
  };

  const geocoder = {
    minIntervalMs: 0,
    reverseGeocode: jest.fn(),
    geocodeCity: jest.fn().mockResolvedValue({
      matchedName: 'Indore, Madhya Pradesh, India',
      ...INDORE,
      widthKm: 20.1,
      heightKm: 24.6,
      provider: 'google',
      attribution: 'Map data ©2026 Google',
    }),
  };

  return { prisma, tx, geocoder };
}

function build(deps: ReturnType<typeof buildDeps>): AreasService {
  return new AreasService(deps.prisma as never, deps.geocoder);
}

function anArea(name: string, lat: number, lng: number, bookings = 0) {
  return {
    id: `area-${name}`,
    name,
    minLat: lat,
    maxLat: lat + 0.018,
    minLng: lng,
    maxLng: lng + 0.02,
    isActive: true,
    _count: { bookings },
  };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  return 200;
}

describe('cityBounds', () => {
  it('asks the geocoder and passes the box back', async () => {
    const deps = buildDeps();

    const bounds = await build(deps).cityBounds('Indore, MP');

    expect(deps.geocoder.geocodeCity).toHaveBeenCalledWith('Indore, MP');
    expect(bounds.heightKm).toBe(24.6);
  });

  /** The number an admin needs *before* the rows exist, not after. */
  it('counts the cells a box would produce without producing any', () => {
    const deps = buildDeps();

    const atOne = build(deps).countCellsFor(INDORE, 1);
    const atFive = build(deps).countCellsFor(INDORE, 5);

    expect(atOne).toBeGreaterThan(400);
    expect(atFive).toBeLessThan(atOne / 10);
    expect(deps.prisma.area.create).not.toHaveBeenCalled();
  });
});

describe('generateGridForBox', () => {
  it('creates a cell per grid position', async () => {
    const deps = buildDeps();

    await build(deps).generateGridForBox({
      cityId: CITY,
      box: INDORE,
      cellSizeKm: 10,
    });

    expect(deps.prisma.area.create).toHaveBeenCalled();
    const first = deps.prisma.area.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(first.data).toMatchObject({
      cityId: CITY,
      nameSource: 'generated',
      gridRef: 'A1',
    });
  });

  it('refuses on a city that already has areas, and says what to use', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(36);

    expect(
      await statusOf(
        build(deps).generateGridForBox({
          cityId: CITY,
          box: INDORE,
          cellSizeKm: 1,
        }),
      ),
    ).toBe(HttpStatus.CONFLICT);
  });

  it('rejects an inverted box', async () => {
    const deps = buildDeps();

    expect(
      await statusOf(
        build(deps).generateGridForBox({
          cityId: CITY,
          box: { ...INDORE, maxLat: INDORE.minLat - 1 },
          cellSizeKm: 1,
        }),
      ),
    ).toBe(HttpStatus.BAD_REQUEST);
  });
});

describe('deactivateOutside', () => {
  const inside = anArea('C3', 22.72, 75.85);
  const farNorth = anArea('A1', 23.1, 75.85);
  const farEast = anArea('B9', 22.72, 76.3);

  it('deactivates only the cells whose centre is outside', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([inside, farNorth, farEast]);

    const result = await build(deps).deactivateOutside({
      cityId: CITY,
      box: INDORE,
    });

    expect(result).toMatchObject({ considered: 3, deactivated: 2, kept: 1 });
    expect(deps.prisma.area.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['area-A1', 'area-B9'] } },
      data: { isActive: false },
    });
  });

  /** Bulk edits to a live service map deserve a look before they happen. */
  it('changes nothing on a dry run but still reports', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([inside, farNorth]);

    const result = await build(deps).deactivateOutside({
      cityId: CITY,
      box: INDORE,
      dryRun: true,
    });

    expect(result).toMatchObject({ deactivated: 0, kept: 1, dryRun: true });
    expect(result.names).toEqual(['A1']);
    expect(deps.prisma.area.updateMany).not.toHaveBeenCalled();
  });

  it('touches nothing when every cell is inside', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([inside]);

    const result = await build(deps).deactivateOutside({
      cityId: CITY,
      box: INDORE,
    });

    expect(result.deactivated).toBe(0);
    expect(deps.prisma.area.updateMany).not.toHaveBeenCalled();
  });

  it('never deletes — a booking may point at the cell', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([farNorth]);

    await build(deps).deactivateOutside({ cityId: CITY, box: INDORE });

    expect(deps.tx.area.deleteMany).not.toHaveBeenCalled();
  });

  it('caps the reported names rather than paging them', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue(
      Array.from({ length: 300 }, (_, i) => anArea(`X${i}`, 23.5, 76.5)),
    );

    const result = await build(deps).deactivateOutside({
      cityId: CITY,
      box: INDORE,
    });

    expect(result.deactivated).toBe(300);
    expect(result.names).toHaveLength(200);
  });
});

describe('regenerate', () => {
  it('deletes cells nothing has booked', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([
      anArea('A1', 22.72, 75.85, 0),
      anArea('A2', 22.72, 75.87, 0),
    ]);

    const result = await build(deps).regenerate({
      cityId: CITY,
      box: INDORE,
      cellSizeKm: 10,
    });

    expect(result.deleted).toBe(2);
    expect(result.retired).toBe(0);
    expect(deps.tx.area.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['area-A1', 'area-A2'] } },
    });
  });

  /**
   * `Booking.areaId` is `SetNull`, so deleting a booked cell silently erases
   * where that work was sold. It is kept, deactivated and renamed instead.
   */
  it('retires a cell with booking history rather than deleting it', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([
      anArea('A1', 22.72, 75.85, 4),
    ]);

    const result = await build(deps).regenerate({
      cityId: CITY,
      box: INDORE,
      cellSizeKm: 10,
    });

    expect(result.retired).toBe(1);
    expect(result.deleted).toBe(0);
    expect(deps.tx.area.deleteMany).not.toHaveBeenCalled();

    const { data } = deps.tx.area.update.mock.calls[0][0] as {
      data: { isActive: boolean; name: string };
    };
    expect(data.isActive).toBe(false);
    expect(data.name).toMatch(/^A1 \(retired \d{4}-\d{2}-\d{2}\)$/);
  });

  /**
   * The rename is not cosmetic. `@@unique([cityId, name])` means a retired A1
   * would collide with the new grid's A1, and the whole regeneration would
   * fail on a constraint.
   */
  it('renames the retired cell before the new grid is created', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([
      anArea('A1', 22.72, 75.85, 1),
    ]);

    await build(deps).regenerate({
      cityId: CITY,
      box: INDORE,
      cellSizeKm: 10,
    });

    const renameOrder = deps.tx.area.update.mock.invocationCallOrder[0];
    const createOrder = deps.prisma.area.create.mock.invocationCallOrder[0];
    expect(renameOrder).toBeLessThan(createOrder);
  });

  it('handles a mix of booked and unbooked cells', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([
      anArea('A1', 22.72, 75.85, 3),
      anArea('A2', 22.72, 75.87, 0),
      anArea('A3', 22.72, 75.89, 0),
    ]);

    const result = await build(deps).regenerate({
      cityId: CITY,
      box: INDORE,
      cellSizeKm: 10,
    });

    expect(result).toMatchObject({ retired: 1, deleted: 2 });
  });

  it('works on a city with no map yet', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([]);

    const result = await build(deps).regenerate({
      cityId: CITY,
      box: INDORE,
      cellSizeKm: 10,
    });

    expect(result).toMatchObject({ retired: 0, deleted: 0 });
    expect(deps.prisma.area.create).toHaveBeenCalled();
  });
});
