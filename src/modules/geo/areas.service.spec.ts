import { HttpException } from '@nestjs/common';
import { AreasService } from './areas.service';

function buildDeps() {
  const prisma = {
    city: { findUnique: jest.fn().mockResolvedValue({ id: 'city-indore' }) },
    service: {
      findUnique: jest.fn().mockResolvedValue({ id: 'svc-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(),
    pro: {
      findUnique: jest.fn().mockResolvedValue({ id: 'pro-1' }),
      // Staffed by default, so the cases that are not about the gate are not
      // about the gate.
      count: jest.fn().mockResolvedValue(3),
    },
    area: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
    },
    areaService: { upsert: jest.fn(), findMany: jest.fn() },
    proArea: { upsert: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma };
}

function build(deps: ReturnType<typeof buildDeps>): AreasService {
  return new AreasService(deps.prisma as never);
}

/** A ~6 km cell over Vijay Nagar. */
function anArea(overrides: Record<string, unknown> = {}) {
  return {
    id: 'area-vn',
    cityId: 'city-indore',
    name: 'Vijay Nagar',
    minLat: 22.714,
    maxLat: 22.768,
    minLng: 75.858,
    maxLng: 75.916,
    isActive: true,
    ...overrides,
  };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    throw new Error('expected a rejection');
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe('AreasService · create', () => {
  const input = {
    cityId: 'city-indore',
    name: 'Vijay Nagar',
    minLat: 22.714,
    maxLat: 22.768,
    minLng: 75.858,
    maxLng: 75.916,
  };

  it('stores the bounds it was given', async () => {
    const deps = buildDeps();
    deps.prisma.area.create.mockResolvedValue(anArea());

    await build(deps).create(input);

    expect(deps.prisma.area.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          minLat: 22.714,
          maxLat: 22.768,
          minLng: 75.858,
          maxLng: 75.916,
        }),
      }),
    );
  });

  /** Swapping min and max should read as a sentence, not a constraint error. */
  it('refuses an inverted rectangle', async () => {
    const deps = buildDeps();

    expect(
      await statusOf(
        build(deps).create({ ...input, minLat: 22.768, maxLat: 22.714 }),
      ),
    ).toBe(400);
    expect(deps.prisma.area.create).not.toHaveBeenCalled();
  });

  /**
   * A zero-height box satisfies `min <= max`, looks correct, and silently
   * matches nothing forever — which is why it is caught separately.
   */
  it('refuses a degenerate rectangle with no height or width', async () => {
    const deps = buildDeps();

    expect(
      await statusOf(
        build(deps).create({ ...input, minLat: 22.714, maxLat: 22.714 }),
      ),
    ).toBe(400);
    expect(
      await statusOf(
        build(deps).create({ ...input, minLng: 75.858, maxLng: 75.858 }),
      ),
    ).toBe(400);
  });

  it('refuses an unknown city', async () => {
    const deps = buildDeps();
    deps.prisma.city.findUnique.mockResolvedValue(null);

    expect(await statusOf(build(deps).create(input))).toBe(404);
  });

  it('refuses a duplicate name in the same city', async () => {
    const deps = buildDeps();
    deps.prisma.area.findFirst.mockResolvedValue({ id: 'existing' });

    expect(await statusOf(build(deps).create(input))).toBe(409);
  });
});

describe('AreasService · generateGridForCity', () => {
  const input = {
    cityId: 'city-indore',
    centerLat: 22.7196,
    centerLng: 75.857,
    extentKm: 12,
    cellSizeKm: 6,
  };

  it('creates a whole grid in one transaction', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(0);
    deps.prisma.$transaction = jest.fn().mockResolvedValue([]);

    await build(deps).generateGridForCity(input);

    // 12 km either side at 6 km cells → 4×4.
    expect(deps.prisma.area.create).toHaveBeenCalledTimes(16);
    expect(deps.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('names cells by grid position for an admin to rename', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(0);
    deps.prisma.$transaction = jest.fn().mockResolvedValue([]);

    await build(deps).generateGridForCity(input);

    const names = deps.prisma.area.create.mock.calls.map(
      (call: [{ data: { name: string } }]) => call[0].data.name,
    );
    expect(names).toContain('A1');
    expect(names).toContain('D4');
  });

  /**
   * Generating a second grid over an existing one is never what someone
   * means, and the overlap would be exactly the ambiguity this shape exists
   * to avoid.
   */
  it('refuses to run on a city that already has areas', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(16);

    expect(await statusOf(build(deps).generateGridForCity(input))).toBe(409);
    expect(deps.prisma.area.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown city', async () => {
    const deps = buildDeps();
    deps.prisma.city.findUnique.mockResolvedValue(null);
    deps.prisma.area.count.mockResolvedValue(0);

    expect(await statusOf(build(deps).generateGridForCity(input))).toBe(404);
  });
});

describe('AreasService · overlapsFor', () => {
  /**
   * The meaning inverted when the shape changed. With circles overlap was
   * healthy — it kept a city gapless. With rectangles it is a warning: a
   * generated grid tiles exactly, so anything here means a hand-edit broke the
   * partition.
   */
  it('reports genuinely overlapping neighbours, largest first', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.area.findMany.mockResolvedValue([
      // Overlaps most of the cell.
      anArea({
        id: 'area-big',
        name: 'Big',
        minLat: 22.72,
        maxLat: 22.79,
        minLng: 75.86,
        maxLng: 75.93,
      }),
      // Clips one corner.
      anArea({
        id: 'area-corner',
        name: 'Corner',
        minLat: 22.766,
        maxLat: 22.8,
        minLng: 75.914,
        maxLng: 75.95,
      }),
    ]);

    const overlaps = await build(deps).overlapsFor('area-vn');

    expect(overlaps.map((o) => o.areaId)).toEqual(['area-big', 'area-corner']);
    expect(overlaps[0].overlapSqKm).toBeGreaterThan(overlaps[1].overlapSqKm);
  });

  /**
   * Adjacent cells share an edge by design, and half-open bounds put a pin on
   * it in exactly one of them. Reporting that as overlap would make every
   * generated grid look broken.
   */
  it('does not count a shared edge as overlap', async () => {
    const deps = buildDeps();
    const cell = anArea();
    deps.prisma.area.findUnique.mockResolvedValue(cell);
    deps.prisma.area.findMany.mockResolvedValue([
      anArea({
        id: 'area-north',
        name: 'North',
        minLat: cell.maxLat,
        maxLat: cell.maxLat + 0.054,
      }),
      anArea({
        id: 'area-east',
        name: 'East',
        minLng: cell.maxLng,
        maxLng: cell.maxLng + 0.058,
      }),
    ]);

    expect(await build(deps).overlapsFor('area-vn')).toEqual([]);
  });

  it('omits areas nowhere near', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    // Bhopal.
    deps.prisma.area.findMany.mockResolvedValue([
      anArea({
        id: 'area-far',
        minLat: 23.2,
        maxLat: 23.3,
        minLng: 77.4,
        maxLng: 77.5,
      }),
    ]);

    expect(await build(deps).overlapsFor('area-vn')).toEqual([]);
  });

  it('never compares an area with itself', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());

    await build(deps).overlapsFor('area-vn');

    expect(deps.prisma.area.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: 'area-vn' } }),
      }),
    );
  });
});

describe('AreasService · neighbourIdsOf', () => {
  /** Cells sharing an edge are neighbours; the rectangle model makes this two lines. */
  it('finds cells that share an edge', async () => {
    const deps = buildDeps();
    const cell = anArea();
    deps.prisma.area.findUnique.mockResolvedValue(cell);
    deps.prisma.area.findMany.mockResolvedValue([
      anArea({
        id: 'north',
        minLat: cell.maxLat,
        maxLat: cell.maxLat + 0.054,
      }),
      anArea({
        id: 'east',
        minLng: cell.maxLng,
        maxLng: cell.maxLng + 0.058,
      }),
    ]);

    expect(await build(deps).neighbourIdsOf('area-vn', 1)).toEqual([
      'north',
      'east',
    ]);
  });

  it('excludes cells across town', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.area.findMany.mockResolvedValue([
      anArea({
        id: 'far',
        minLat: 23.2,
        maxLat: 23.3,
        minLng: 77.4,
        maxLng: 77.5,
      }),
    ]);

    expect(await build(deps).neighbourIdsOf('area-vn', 1)).toEqual([]);
  });

  /**
   * Widening a Bhopal booking into Indore because the grids happen to abut
   * would be worse than not assigning it.
   */
  it('never leaves the city', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());

    await build(deps).neighbourIdsOf('area-vn', 1);

    expect(deps.prisma.area.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cityId: 'city-indore' }),
      }),
    );
  });
});

describe('AreasService · the staffing gate', () => {
  /**
   * The check that stops "we sell it here" and "someone can do it here" from
   * drifting apart. They are configured by different people for different
   * reasons, and nothing else notices when they disagree (#46).
   */
  it('refuses to switch a service on where nobody is staffed', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.pro.count.mockResolvedValue(0);

    expect(
      await statusOf(
        build(deps).setServiceAvailability('area-vn', 'svc-1', true),
      ),
    ).toBe(409);
    expect(deps.prisma.areaService.upsert).not.toHaveBeenCalled();
  });

  it('counts approved Pros posted to the area who hold the service', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());

    await build(deps).countProsCapableInArea('area-vn', 'svc-1');

    expect(deps.prisma.pro.count).toHaveBeenCalledWith({
      where: {
        status: 'approved',
        areas: { some: { areaId: 'area-vn', isActive: true } },
        services: { some: { serviceId: 'svc-1', isActive: true } },
      },
    });
  });

  /**
   * Deliberately ignores `isAvailable`. That flag is today's roster, and a
   * service must not become unsellable because everyone is off shift this
   * afternoon — this answers the structural question, not the timing one.
   */
  it('does not consider whether those Pros are on duty right now', async () => {
    const deps = buildDeps();
    await build(deps).countProsCapableInArea('area-vn', 'svc-1');

    const { where } = deps.prisma.pro.count.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(where).not.toHaveProperty('isAvailable');
  });

  /**
   * Switching OFF must always work — otherwise an area that lost its last Pro
   * could never be corrected, which is exactly when someone needs to.
   */
  it('never blocks switching a service off', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.pro.count.mockResolvedValue(0);

    await build(deps).setServiceAvailability('area-vn', 'svc-1', false);

    expect(deps.prisma.areaService.upsert).toHaveBeenCalled();
  });

  it('applies nothing when a bulk activation includes an unstaffed area', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.service.findUnique.mockResolvedValue({ id: 'svc-1' });
    deps.prisma.area.findMany.mockResolvedValue([
      anArea({ id: 'a' }),
      anArea({ id: 'b' }),
    ]);
    deps.prisma.pro.count.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    deps.prisma.$transaction = jest.fn();

    expect(
      await statusOf(
        build(deps).setServiceAcrossAreas('svc-1', ['a', 'b'], true),
      ),
    ).toBe(409);
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('AreasService · setServiceAvailability', () => {
  it('upserts, so re-enabling a service is not a constraint error', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());

    await build(deps).setServiceAvailability('area-vn', 'svc-1', true);

    expect(deps.prisma.areaService.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { areaId_serviceId: { areaId: 'area-vn', serviceId: 'svc-1' } },
        update: { isActive: true },
      }),
    );
  });

  it('refuses an unknown service', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.service.findUnique.mockResolvedValue(null);

    expect(
      await statusOf(
        build(deps).setServiceAvailability('area-vn', 'nope', true),
      ),
    ).toBe(404);
  });
});

describe('AreasService · setServicesForArea', () => {
  function withTx(deps: ReturnType<typeof buildDeps>) {
    const tx = {
      areaService: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        upsert: jest.fn(),
      },
    };
    deps.prisma.$transaction = jest.fn((fn: (t: typeof tx) => unknown) =>
      fn(tx),
    );
    return tx;
  }

  /**
   * Declarative, not incremental. What you send ends up on and everything else
   * ends up off — so an admin screen saves its whole state in one call instead
   * of diffing against the server and firing N toggles.
   */
  it('switches off everything not in the list', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.service.findMany.mockResolvedValue([
      { id: 'svc-1' },
      { id: 'svc-2' },
    ]);
    const tx = withTx(deps);

    const result = await build(deps).setServicesForArea('area-vn', [
      'svc-1',
      'svc-2',
    ]);

    expect(tx.areaService.updateMany).toHaveBeenCalledWith({
      where: {
        areaId: 'area-vn',
        serviceId: { notIn: ['svc-1', 'svc-2'] },
        isActive: true,
      },
      data: { isActive: false },
    });
    expect(tx.areaService.upsert).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ activated: 2, deactivated: 2 });
  });

  it('accepts an empty list, which means "this area offers nothing"', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    const tx = withTx(deps);

    await build(deps).setServicesForArea('area-vn', []);

    expect(tx.areaService.upsert).not.toHaveBeenCalled();
    expect(tx.areaService.updateMany).toHaveBeenCalled();
  });

  it('de-duplicates a repeated service id', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.service.findMany.mockResolvedValue([{ id: 'svc-1' }]);
    const tx = withTx(deps);

    const result = await build(deps).setServicesForArea('area-vn', [
      'svc-1',
      'svc-1',
    ]);

    expect(tx.areaService.upsert).toHaveBeenCalledTimes(1);
    expect(result.activated).toBe(1);
  });

  /**
   * All-or-nothing. A partial apply would leave the admin's screen disagreeing
   * with the database about what they just saved.
   */
  it('applies nothing when any service id is unknown', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.service.findMany.mockResolvedValue([{ id: 'svc-1' }]);
    deps.prisma.$transaction = jest.fn();

    expect(
      await statusOf(
        build(deps).setServicesForArea('area-vn', ['svc-1', 'svc-ghost']),
      ),
    ).toBe(404);
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('AreasService · copyServicesBetweenAreas', () => {
  it('replaces the target’s list with the source’s active services', async () => {
    const deps = buildDeps();
    deps.prisma.area.findUnique.mockResolvedValue(anArea());
    deps.prisma.areaService.findMany = jest
      .fn()
      .mockResolvedValue([{ serviceId: 'svc-1' }, { serviceId: 'svc-2' }]);
    deps.prisma.service.findMany.mockResolvedValue([
      { id: 'svc-1' },
      { id: 'svc-2' },
    ]);
    const tx = {
      areaService: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn(),
      },
    };
    deps.prisma.$transaction = jest.fn((fn: (t: typeof tx) => unknown) =>
      fn(tx),
    );

    await build(deps).copyServicesBetweenAreas('area-source', 'area-target');

    expect(deps.prisma.areaService.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { areaId: 'area-source', isActive: true },
      }),
    );
    expect(tx.areaService.upsert).toHaveBeenCalledTimes(2);
  });

  it('refuses to copy an area onto itself', async () => {
    const deps = buildDeps();
    expect(
      await statusOf(
        build(deps).copyServicesBetweenAreas('area-vn', 'area-vn'),
      ),
    ).toBe(400);
  });
});

describe('AreasService · serviceMatrixForCity', () => {
  /**
   * "Never configured" and "switched off" look identical to a customer, and an
   * admin needs to see both as gaps — but distinguish them when deciding what
   * to do next.
   */
  it('distinguishes never-configured from switched-off', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([
      {
        ...anArea(),
        areaServices: [
          { serviceId: 'svc-1', isActive: true },
          { serviceId: 'svc-2', isActive: false },
        ],
      },
    ]);
    deps.prisma.service.findMany.mockResolvedValue([
      { id: 'svc-1', name: 'AC Repair' },
      { id: 'svc-2', name: 'Deep Clean' },
      { id: 'svc-3', name: 'Plumbing' },
    ]);

    const matrix = await build(deps).serviceMatrixForCity('city-indore');

    expect(matrix.areas[0].availability).toEqual([
      expect.objectContaining({
        serviceId: 'svc-1',
        isAvailable: true,
        isConfigured: true,
      }),
      expect.objectContaining({
        serviceId: 'svc-2',
        isAvailable: false,
        isConfigured: true,
      }),
      // No row at all — nobody has decided about plumbing here.
      expect.objectContaining({
        serviceId: 'svc-3',
        isAvailable: false,
        isConfigured: false,
      }),
    ]);
  });
});

describe('AreasService · proIdsForArea', () => {
  /**
   * The distinction dispatch depends on. An empty array would exclude every
   * Pro in the city and report a supply gap; `null` means "nobody posted, do
   * not filter" — a configuration gap, which is a different problem.
   */
  it('returns null when nobody is posted, not an empty array', async () => {
    const deps = buildDeps();
    deps.prisma.proArea.findMany.mockResolvedValue([]);

    expect(await build(deps).proIdsForArea('area-vn')).toBeNull();
  });

  it('returns the posted ids when there are any', async () => {
    const deps = buildDeps();
    deps.prisma.proArea.findMany.mockResolvedValue([
      { proId: 'pro-1' },
      { proId: 'pro-2' },
    ]);

    expect(await build(deps).proIdsForArea('area-vn')).toEqual([
      'pro-1',
      'pro-2',
    ]);
  });

  it('counts only active postings', async () => {
    const deps = buildDeps();
    await build(deps).proIdsForArea('area-vn');

    // Single-area lookups go through the multi-area query dispatch's widening
    // step uses, so there is one path to keep correct rather than two.
    expect(deps.prisma.proArea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { areaId: { in: ['area-vn'] }, isActive: true },
      }),
    );
  });

  it('de-duplicates a Pro posted to several of the areas asked about', async () => {
    const deps = buildDeps();
    deps.prisma.proArea.findMany.mockResolvedValue([
      { proId: 'pro-1' },
      { proId: 'pro-1' },
      { proId: 'pro-2' },
    ]);

    expect(await build(deps).proIdsForAreas(['a', 'b'])).toEqual([
      'pro-1',
      'pro-2',
    ]);
  });
});
