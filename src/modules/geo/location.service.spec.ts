import { HttpException } from '@nestjs/common';
import { LocationService } from './location.service';

function buildDeps() {
  const prisma = {
    area: { findMany: jest.fn().mockResolvedValue([]) },
    areaService: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const settings = { getString: jest.fn().mockResolvedValue('false') };
  const catalog = { listServices: jest.fn().mockResolvedValue([]) };
  const geocoder = {
    minIntervalMs: 0,
    reverseGeocode: jest.fn().mockResolvedValue({
      addressLine: '12 MG Road, Vijay Nagar, Indore, MP 452010, India',
      cityCandidates: ['Indore'],
      stateName: 'Madhya Pradesh',
      postalCode: '452010',
      provider: 'google',
      attribution: 'Map data ©2026 Google',
    }),
  };
  return { prisma, settings, catalog, geocoder };
}

function build(deps: ReturnType<typeof buildDeps>): LocationService {
  return new LocationService(
    deps.prisma as never,
    deps.settings as never,
    deps.catalog as never,
    deps.geocoder,
  );
}

/** A ~6 km cell over Vijay Nagar. */
function anArea(overrides: Record<string, unknown> = {}) {
  return {
    id: 'area-vn',
    name: 'Vijay Nagar',
    cityId: 'city-indore',
    minLat: 22.714,
    maxLat: 22.768,
    minLng: 75.858,
    maxLng: 75.916,
    city: { id: 'city-indore', name: 'Indore' },
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

describe('LocationService · resolveArea', () => {
  it('resolves a pin inside a cell', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);

    expect(await build(deps).resolveArea(22.7533, 75.8937)).toEqual({
      areaId: 'area-vn',
      areaName: 'Vijay Nagar',
      cityId: 'city-indore',
      cityName: 'Indore',
    });
  });

  /**
   * The shape's payoff: containment is four range comparisons the database
   * answers from an index, not a scan with trigonometry. If this query ever
   * stops being half-open, a pin on a shared edge lands in two cells.
   */
  it('asks the database for containment with half-open bounds', async () => {
    const deps = buildDeps();
    await build(deps).resolveArea(22.7533, 75.8937);

    expect(deps.prisma.area.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          city: { isActive: true },
          minLat: { lte: 22.7533 },
          maxLat: { gt: 22.7533 },
          minLng: { lte: 75.8937 },
          maxLng: { gt: 75.8937 },
        }),
      }),
    );
  });

  it('returns null for a pin in no cell', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([]);

    expect(await build(deps).resolveArea(23.2599, 77.4126)).toBeNull();
  });

  /**
   * A generated grid never produces two matches. Hand-drawn areas can — most
   * usefully on purpose, a small precise box inside a larger fallback. The
   * most specific answer wins.
   */
  it('picks the smallest box when two areas both claim the pin', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([
      anArea({
        id: 'area-big',
        name: 'Whole City',
        minLat: 22.6,
        maxLat: 22.9,
        minLng: 75.7,
        maxLng: 76.0,
      }),
      anArea({ id: 'area-small', name: 'Vijay Nagar' }),
    ]);

    const resolved = await build(deps).resolveArea(22.7533, 75.8937);

    expect(resolved!.areaId).toBe('area-small');
  });

  it('is stable — row order does not change the answer', async () => {
    const deps = buildDeps();
    const areas = [
      anArea({
        id: 'area-big',
        minLat: 22.6,
        maxLat: 22.9,
        minLng: 75.7,
        maxLng: 76.0,
      }),
      anArea({ id: 'area-small' }),
    ];
    deps.prisma.area.findMany.mockResolvedValue(areas);
    const service = build(deps);

    const first = await service.resolveArea(22.7533, 75.8937);
    deps.prisma.area.findMany.mockResolvedValue([...areas].reverse());
    const second = await service.resolveArea(22.7533, 75.8937);

    expect(first!.areaId).toBe(second!.areaId);
  });

  it('breaks an exact size tie by id, so the answer never flickers', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([
      anArea({ id: 'zzz' }),
      anArea({ id: 'aaa' }),
    ]);

    expect((await build(deps).resolveArea(22.7533, 75.8937))!.areaId).toBe(
      'aaa',
    );
  });

  /**
   * A malformed coordinate must not read as "we do not serve you". That is a
   * 400 about the request, not a 200 about our coverage.
   */
  it('rejects a NaN coordinate rather than reporting it unserviceable', async () => {
    const deps = buildDeps();
    expect(await statusOf(build(deps).resolveArea(Number.NaN, 75.89))).toBe(
      400,
    );
    expect(deps.prisma.area.findMany).not.toHaveBeenCalled();
  });

  it('rejects a coordinate out of range', async () => {
    const deps = buildDeps();
    expect(await statusOf(build(deps).resolveArea(22.75, 999))).toBe(400);
  });
});

describe('LocationService · checkServiceability', () => {
  it('distinguishes "we are not here" from "we are here but not for that"', async () => {
    const deps = buildDeps();

    // Outside every cell.
    deps.prisma.area.findMany.mockResolvedValue([]);
    const nowhere = await build(deps).checkServiceability({
      lat: 23.2599,
      lng: 77.4126,
      serviceId: 'svc-1',
    });
    expect(nowhere).toMatchObject({
      serviceable: false,
      area: null,
      code: 'LOCATION_NOT_SERVICEABLE',
    });

    // Inside a cell, but the service is not listed there.
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);
    deps.prisma.areaService.findUnique.mockResolvedValue(null);
    const wrongService = await build(deps).checkServiceability({
      lat: 22.7533,
      lng: 75.8937,
      serviceId: 'svc-1',
    });
    expect(wrongService).toMatchObject({
      serviceable: false,
      code: 'SERVICE_NOT_AVAILABLE_IN_AREA',
    });
    // The area is still returned — the customer is somewhere we operate.
    expect(wrongService.area).not.toBeNull();
  });

  it('answers only the location question when no service is named', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);

    const result = await build(deps).checkServiceability({
      lat: 22.7533,
      lng: 75.8937,
    });

    expect(result.serviceable).toBe(true);
    expect(deps.prisma.areaService.findUnique).not.toHaveBeenCalled();
  });

  it('treats a deactivated AreaService row as unavailable', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);
    deps.prisma.areaService.findUnique.mockResolvedValue({ isActive: false });

    expect(
      (
        await build(deps).checkServiceability({
          lat: 22.7533,
          lng: 75.8937,
          serviceId: 'svc-1',
        })
      ).serviceable,
    ).toBe(false);
  });

  it('is available when the row exists and is active', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);
    deps.prisma.areaService.findUnique.mockResolvedValue({ isActive: true });

    expect(
      (
        await build(deps).checkServiceability({
          lat: 22.7533,
          lng: 75.8937,
          serviceId: 'svc-1',
        })
      ).serviceable,
    ).toBe(true);
  });
});

describe('LocationService · reverseGeocode', () => {
  /**
   * One call, both halves. A client that has just dragged a pin renders the
   * address and the availability banner together; two round trips let them
   * disagree on screen for a beat.
   */
  it('returns the address and the resolved area together', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);

    const result = await build(deps).reverseGeocode(22.7533, 75.8937);

    expect(result.addressLine).toContain('MG Road');
    expect(result.attribution).toBe('Map data ©2026 Google');
    expect(result.area).toMatchObject({ areaName: 'Vijay Nagar' });
  });

  /**
   * The address is the provider's; the area is ours. A pin outside our grid
   * still has a perfectly good street address, and saying so is more useful
   * than refusing to answer.
   */
  it('still returns an address for a pin we do not serve', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([]);

    const result = await build(deps).reverseGeocode(23.2599, 77.4126);

    expect(result.addressLine).toContain('MG Road');
    expect(result.area).toBeNull();
  });

  it('rejects a malformed coordinate before calling the provider', async () => {
    const deps = buildDeps();

    expect(await statusOf(build(deps).reverseGeocode(Number.NaN, 75.89))).toBe(
      400,
    );
  });
});

describe('LocationService · catalogForLocation', () => {
  const catalogue = [
    { id: 'svc-ac', name: 'Split AC Service', flatPrice: '599.00' },
    { id: 'svc-deep', name: 'Deep Cleaning', flatPrice: '4999.00' },
  ];

  /**
   * The whole point of this endpoint. Without it a customer in Rau browses the
   * national catalogue, picks the deep clean, fills in a booking, and only
   * then hits SERVICE_NOT_AVAILABLE_IN_AREA — the check at the wrong end of
   * the funnel.
   */
  it('flags each service against the resolved area', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([anArea({ name: 'Rau' })]);
    deps.catalog.listServices.mockResolvedValue(catalogue);
    deps.prisma.areaService.findMany.mockResolvedValue([
      { serviceId: 'svc-ac' },
    ]);

    const result = await build(deps).catalogForLocation({
      lat: 22.7533,
      lng: 75.8937,
    });

    expect(result.serviceable).toBe(true);
    expect(result.services).toEqual([
      expect.objectContaining({
        id: 'svc-ac',
        isAvailable: true,
        unavailableReason: null,
      }),
      expect.objectContaining({
        id: 'svc-deep',
        isAvailable: false,
        unavailableReason: 'Not available in Rau yet',
      }),
    ]);
  });

  /**
   * Hiding them would make a thinly-mapped area look like an empty product,
   * and would throw away the signal that tells ops where to expand.
   */
  it('returns unavailable services rather than hiding them', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);
    deps.catalog.listServices.mockResolvedValue(catalogue);
    deps.prisma.areaService.findMany.mockResolvedValue([]);

    const result = await build(deps).catalogForLocation({
      lat: 22.7533,
      lng: 75.8937,
    });

    expect(result.services).toHaveLength(2);
    expect(result.services.every((s) => !s.isAvailable)).toBe(true);
  });

  /** A customer outside our coverage is still allowed to look. */
  it('returns the catalogue as all-unavailable for a pin in no area', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([]);
    deps.catalog.listServices.mockResolvedValue(catalogue);

    const result = await build(deps).catalogForLocation({
      lat: 23.2599,
      lng: 77.4126,
    });

    expect(result).toMatchObject({
      area: null,
      serviceable: false,
      code: 'LOCATION_NOT_SERVICEABLE',
    });
    expect(result.services).toHaveLength(2);
    expect(result.services.every((s) => !s.isAvailable)).toBe(true);
  });

  it('passes browse filters through to the catalogue', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);
    deps.prisma.areaService.findMany.mockResolvedValue([]);

    await build(deps).catalogForLocation({
      lat: 22.7533,
      lng: 75.8937,
      query: { q: 'clean' },
    });

    expect(deps.catalog.listServices).toHaveBeenCalledWith({ q: 'clean' });
  });

  /** This runs on the first screen of every session. */
  it('reads availability in one query, not one per service', async () => {
    const deps = buildDeps();
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);
    deps.catalog.listServices.mockResolvedValue(catalogue);
    deps.prisma.areaService.findMany.mockResolvedValue([]);

    await build(deps).catalogForLocation({ lat: 22.7533, lng: 75.8937 });

    expect(deps.prisma.areaService.findMany).toHaveBeenCalledTimes(1);
    expect(deps.prisma.areaService.findUnique).not.toHaveBeenCalled();
  });
});

describe('LocationService · resolveForBooking', () => {
  const booking = {
    lat: 23.2599,
    lng: 77.4126,
    serviceId: 'svc-1',
    cityId: 'city-indore',
  };

  /**
   * The whole reason enforcement is a setting. With no areas drawn, a gate
   * that shipped enabled would reject every booking in every city on deploy.
   */
  it('does not reject while the city gate is off', async () => {
    const deps = buildDeps();
    deps.settings.getString.mockResolvedValue('false');

    await expect(build(deps).resolveForBooking(booking)).resolves.toEqual({
      areaId: null,
    });
  });

  it('rejects once the city gate is on', async () => {
    const deps = buildDeps();
    deps.settings.getString.mockResolvedValue('true');

    expect(await statusOf(build(deps).resolveForBooking(booking))).toBe(409);
  });

  /**
   * What makes flipping the gate on a measured step rather than a leap: the
   * area is recorded even while the gate is off.
   */
  it('records the area even when it is not enforcing', async () => {
    const deps = buildDeps();
    deps.settings.getString.mockResolvedValue('false');
    deps.prisma.area.findMany.mockResolvedValue([anArea()]);
    deps.prisma.areaService.findUnique.mockResolvedValue({ isActive: true });

    await expect(
      build(deps).resolveForBooking({
        ...booking,
        lat: 22.7533,
        lng: 75.8937,
      }),
    ).resolves.toEqual({ areaId: 'area-vn' });
  });

  it('reads the gate per city, not globally', async () => {
    const deps = buildDeps();
    await build(deps).resolveForBooking(booking);

    expect(deps.settings.getString).toHaveBeenCalledWith(
      'geo.enforceAreaServiceAvailability',
      'false',
      'city-indore',
    );
  });
});
