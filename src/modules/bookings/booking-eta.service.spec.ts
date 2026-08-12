import { BookingEtaService } from './booking-eta.service';

const POSITION = { lat: 22.7533, lng: 75.8937 };
const DESTINATION = { lat: 22.7196, lng: 75.8577 };

function buildDeps() {
  const prisma = {
    booking: {
      findUnique: jest.fn().mockResolvedValue({
        address: { pinLat: DESTINATION.lat, pinLng: DESTINATION.lng },
      }),
    },
  };
  const router = {
    estimate: jest.fn().mockResolvedValue({
      minutes: 14,
      distanceMetres: 5200,
      source: 'google',
    }),
  };
  return { prisma, router };
}

function build(deps: ReturnType<typeof buildDeps>): BookingEtaService {
  return new BookingEtaService(deps.prisma as never, deps.router as never);
}

describe('forBooking', () => {
  it('returns the road minutes to the booking’s address', async () => {
    const deps = buildDeps();

    await expect(build(deps).forBooking('bk-1', POSITION)).resolves.toBe(14);
    expect(deps.router.estimate).toHaveBeenCalledWith(
      expect.objectContaining({
        fromLat: POSITION.lat,
        fromLng: POSITION.lng,
        toLat: DESTINATION.lat,
        toLng: DESTINATION.lng,
      }),
    );
  });

  it('is null with no live position — there is nothing to measure from', async () => {
    const deps = buildDeps();

    await expect(build(deps).forBooking('bk-1', null)).resolves.toBeNull();
    expect(deps.router.estimate).not.toHaveBeenCalled();
  });

  it('is null when the booking or its address has gone', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(null);

    await expect(build(deps).forBooking('bk-1', POSITION)).resolves.toBeNull();
  });
});

describe('the rule: never publish a guess as an arrival time', () => {
  /**
   * The whole reason this class exists rather than the tracking service
   * calling the router directly.
   *
   * The router always answers — it degrades to crow-flight when Google is
   * absent or unreachable — and that answer is right for ranking candidates
   * and wrong for a customer, who reads "8 minutes" as a promise. Indore's
   * roads are not straight lines.
   */
  it('returns null for a straight-line estimate, however plausible', async () => {
    const deps = buildDeps();
    deps.router.estimate.mockResolvedValue({
      minutes: 8,
      distanceMetres: null,
      source: 'haversine',
    });

    await expect(build(deps).forBooking('bk-1', POSITION)).resolves.toBeNull();
  });

  it('returns the number for a real road estimate', async () => {
    const deps = buildDeps();
    deps.router.estimate.mockResolvedValue({
      minutes: 8,
      distanceMetres: 3100,
      source: 'google',
    });

    await expect(build(deps).forBooking('bk-1', POSITION)).resolves.toBe(8);
  });
});

describe('between', () => {
  it('skips the address lookup when the caller already has the pin', async () => {
    const deps = buildDeps();

    await expect(build(deps).between(POSITION, DESTINATION)).resolves.toBe(14);
    expect(deps.prisma.booking.findUnique).not.toHaveBeenCalled();
  });

  /**
   * The router is meant to be total, so a throw here is a bug in it. Either
   * way an ETA is a convenience and the live map is not — a failed estimate
   * must never take a tracking read down with it.
   */
  it('returns null rather than throwing when the router fails', async () => {
    const deps = buildDeps();
    deps.router.estimate.mockRejectedValue(new Error('unexpected'));

    await expect(
      build(deps).between(POSITION, DESTINATION),
    ).resolves.toBeNull();
  });
});
