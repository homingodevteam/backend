import { HttpException } from '@nestjs/common';
import { AreaNamingService } from './area-naming.service';

function buildDeps() {
  const prisma = {
    area: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const geocoder = {
    reverseGeocode: jest.fn().mockResolvedValue({
      addressLine: 'Vijay Nagar, Indore, Madhya Pradesh, India',
      cityCandidates: ['Indore'],
      stateName: 'Madhya Pradesh',
      attribution: 'test',
    }),
  };
  return { prisma, geocoder };
}

function build(deps: ReturnType<typeof buildDeps>): AreaNamingService {
  const service = new AreaNamingService(
    deps.prisma as never,
    deps.geocoder as never,
  );
  // The real pass paces itself at ~1/sec to respect the geocoder's limit. A
  // unit suite must not wait real seconds to prove the loop's behaviour.
  service.paceMs = 1;
  return service;
}

function aCell(overrides: Record<string, unknown> = {}) {
  return {
    id: 'area-1',
    gridRef: 'C3',
    nameSource: 'generated',
    minLat: 22.714,
    maxLat: 22.768,
    minLng: 75.858,
    maxLng: 75.916,
    ...overrides,
  };
}

/** The pass paces itself against the geocoder's 1/sec limit. */
async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

describe('AreaNamingService · start', () => {
  it('does nothing when every cell already has a real name', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(0);

    await expect(build(deps).start('city-indore')).resolves.toEqual({
      queued: 0,
      running: false,
    });
    expect(deps.geocoder.reverseGeocode).not.toHaveBeenCalled();
  });

  /**
   * The pass is rate-limited into the minutes, so it cannot be awaited by a
   * request. Returning a count and continuing is the whole design.
   */
  it('returns immediately with a count rather than awaiting the work', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(36);
    deps.prisma.area.findMany.mockResolvedValue([aCell()]);

    const started = Date.now();
    const result = await build(deps).start('city-indore');

    expect(result).toEqual({ queued: 36, running: true });
    expect(Date.now() - started).toBeLessThan(1000);
    await settle();
  });

  /**
   * Two admins hitting the button would double-spend a budget of one request
   * per second, so the second is refused rather than silently halving the rate.
   */
  it('refuses a second concurrent pass for the same city', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(2);
    deps.prisma.area.findMany.mockResolvedValue([aCell(), aCell({ id: 'a2' })]);
    const service = build(deps);

    await service.start('city-indore');
    expect(await statusOf(service.start('city-indore'))).toBe(409);
    await settle();
  });
});

describe('AreaNamingService · the naming pass', () => {
  it('geocodes the centre of the cell, not a corner', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(1);
    deps.prisma.area.findMany.mockResolvedValue([aCell()]);

    await build(deps).start('city-indore');
    await settle();

    expect(deps.geocoder.reverseGeocode).toHaveBeenCalledWith(
      (22.714 + 22.768) / 2,
      (75.858 + 75.916) / 2,
    );
  });

  /**
   * Nominatim returns a whole address line. The first component is the
   * locality an admin recognises; the rest is the city and country they
   * already know.
   */
  it('takes the locality, not the whole address line', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(1);
    deps.prisma.area.findMany.mockResolvedValue([aCell()]);

    await build(deps).start('city-indore');
    await settle();

    expect(deps.prisma.area.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: 'Vijay Nagar', nameSource: 'geocoded' },
      }),
    );
  });

  /**
   * The guarantee that makes the pass safe to re-run, and safe to run while an
   * admin is halfway through renaming: the `nameSource: 'generated'` clause is
   * in the WHERE, not just the selection, so a row renamed mid-pass is skipped.
   */
  it('only ever writes to rows still carrying a generated placeholder', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(1);
    deps.prisma.area.findMany.mockResolvedValue([aCell()]);

    await build(deps).start('city-indore');
    await settle();

    expect(deps.prisma.area.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cityId: 'city-indore', nameSource: 'generated' },
      }),
    );
    expect(deps.prisma.area.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'area-1', nameSource: 'generated' },
      }),
    );
  });

  it('suffixes rather than fails when two cells share a locality', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(1);
    deps.prisma.area.findMany.mockResolvedValue([aCell()]);
    // "Vijay Nagar" is taken; "Vijay Nagar 2" is free.
    deps.prisma.area.findFirst
      .mockResolvedValueOnce({ id: 'other' })
      .mockResolvedValue(null);

    await build(deps).start('city-indore');
    await settle();

    expect(deps.prisma.area.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'Vijay Nagar 2' }),
      }),
    );
  });

  /**
   * One unreachable cell must not abandon the other thirty-five. The row keeps
   * its placeholder and the next pass retries it.
   */
  it('keeps going when a single cell fails to geocode', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(2);
    deps.prisma.area.findMany.mockResolvedValue([
      aCell({ id: 'a1', gridRef: 'A1' }),
      aCell({ id: 'a2', gridRef: 'A2' }),
    ]);
    deps.geocoder.reverseGeocode
      .mockRejectedValueOnce(new Error('geocoder down'))
      .mockResolvedValue({
        addressLine: 'Palasia, Indore, Madhya Pradesh, India',
        cityCandidates: ['Indore'],
        stateName: 'Madhya Pradesh',
        attribution: 'test',
      });

    await build(deps).start('city-indore');
    await settle();

    expect(deps.geocoder.reverseGeocode).toHaveBeenCalledTimes(2);
    expect(deps.prisma.area.updateMany).toHaveBeenCalledTimes(1);
  });

  it('leaves the placeholder when the address yields nothing usable', async () => {
    const deps = buildDeps();
    deps.prisma.area.count.mockResolvedValue(1);
    deps.prisma.area.findMany.mockResolvedValue([aCell()]);
    // A bare plot number names nothing an admin would recognise.
    deps.geocoder.reverseGeocode.mockResolvedValue({
      addressLine: '42, Indore, Madhya Pradesh, India',
      cityCandidates: ['Indore'],
      stateName: 'Madhya Pradesh',
      attribution: 'test',
    });

    await build(deps).start('city-indore');
    await settle();

    expect(deps.prisma.area.updateMany).not.toHaveBeenCalled();
  });
});

describe('AreaNamingService · progressFor', () => {
  it('reports the unreviewed worklist and what is awaiting review', async () => {
    const deps = buildDeps();
    deps.prisma.area.count
      .mockResolvedValueOnce(11) // still generated
      .mockResolvedValueOnce(25); // geocoded suggestions

    await expect(build(deps).progressFor('city-indore')).resolves.toMatchObject(
      { pending: 11, suggested: 25, running: false },
    );
  });
});
