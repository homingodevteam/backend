import { TRACKING_CHANNEL } from '../../redis/channels';
import { TrackingBroadcasterService } from './tracking-broadcaster.service';

function buildDeps() {
  const redis = { subscribe: jest.fn(), publish: jest.fn() };
  const prisma = { booking: { findMany: jest.fn().mockResolvedValue([]) } };
  const gateway = { publish: jest.fn() };
  // Returns a real road ETA by default so the happy path is the one exercised;
  // individual tests override it to assert the null cases.
  const eta = { between: jest.fn().mockResolvedValue(12) };
  return { redis, prisma, gateway, eta };
}

function build(deps: ReturnType<typeof buildDeps>): TrackingBroadcasterService {
  return new TrackingBroadcasterService(
    deps.redis as never,
    deps.prisma as never,
    deps.gateway as never,
    deps.eta as never,
  );
}

/** Drives the subscriber the way Redis would. */
async function deliver(
  deps: ReturnType<typeof buildDeps>,
  message: unknown,
): Promise<void> {
  const service = build(deps);
  service.onModuleInit();
  const handler = deps.redis.subscribe.mock.calls[0][1] as (
    payload: unknown,
  ) => void;
  handler(message);
  // The handler kicks off async work it deliberately does not await.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Every trackable booking now carries its destination pin for the ETA. */
const ADDRESS = { pinLat: 22.7196, pinLng: 75.8577 };

const MOVED = {
  proId: 'pro-1',
  lat: 22.75,
  lng: 75.89,
  reportedAt: '2026-08-11T12:00:00.000Z',
};

describe('TrackingBroadcasterService', () => {
  it('subscribes to the shared channel at boot', () => {
    const deps = buildDeps();
    build(deps).onModuleInit();

    expect(deps.redis.subscribe).toHaveBeenCalledWith(
      TRACKING_CHANNEL,
      expect.any(Function),
    );
  });

  it('emits one frame per trackable booking the Pro is on', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([
      { id: 'bk-1', status: 'en_route', address: ADDRESS },
      { id: 'bk-2', status: 'assigned', address: ADDRESS },
    ]);

    await deliver(deps, MOVED);

    expect(deps.gateway.publish).toHaveBeenCalledTimes(2);
    expect(deps.gateway.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'bk-1',
        proId: 'pro-1',
        position: { lat: 22.75, lng: 75.89 },
        isStale: false,
      }),
    );
  });

  /**
   * A position during `started` would park a pin on the customer's own house
   * for an hour, and after completion it would leak where the Pro went next.
   */
  it('only considers bookings where someone is waiting for an arrival', async () => {
    const deps = buildDeps();
    await deliver(deps, MOVED);

    expect(deps.prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          proId: 'pro-1',
          status: { in: ['assigned', 'en_route', 'arrived'] },
        },
      }),
    );
  });

  it('emits nothing when the Pro has no live job', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([]);

    await deliver(deps, MOVED);

    expect(deps.gateway.publish).not.toHaveBeenCalled();
  });

  /**
   * The ETA stays null on purpose. Nothing can compute a road time yet, and a
   * haversine guess published as an arrival time is worse than no number.
   */
  it('publishes the road ETA to that booking’s own address', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([
      { id: 'bk-1', status: 'en_route', address: ADDRESS },
    ]);

    await deliver(deps, MOVED);

    expect(deps.eta.between).toHaveBeenCalledWith(
      { lat: MOVED.lat, lng: MOVED.lng },
      { lat: ADDRESS.pinLat, lng: ADDRESS.pinLng },
    );
    expect(deps.gateway.publish.mock.calls[0][0]).toMatchObject({
      etaMinutes: 12,
    });
  });

  /**
   * The rule the estimator enforces, asserted from the other side: when it
   * declines — no key, no route, provider down — the frame carries null rather
   * than a straight-line guess dressed up as an arrival time.
   */
  it('publishes null when there is no road estimate, never a guess', async () => {
    const deps = buildDeps();
    deps.eta.between.mockResolvedValue(null);
    deps.prisma.booking.findMany.mockResolvedValue([
      { id: 'bk-1', status: 'en_route', address: ADDRESS },
    ]);

    await deliver(deps, MOVED);

    expect(deps.gateway.publish.mock.calls[0][0]).toMatchObject({
      etaMinutes: null,
    });
  });

  /** One ping, several jobs — each gets an ETA to its own destination. */
  it('estimates per booking, not once per ping', async () => {
    const deps = buildDeps();
    const other = { pinLat: 22.7533, pinLng: 75.8937 };
    deps.prisma.booking.findMany.mockResolvedValue([
      { id: 'bk-1', status: 'en_route', address: ADDRESS },
      { id: 'bk-2', status: 'assigned', address: other },
    ]);

    await deliver(deps, MOVED);

    expect(deps.eta.between).toHaveBeenCalledTimes(2);
    expect(deps.eta.between).toHaveBeenCalledWith(expect.anything(), {
      lat: other.pinLat,
      lng: other.pinLng,
    });
  });

  it('ignores a message with no proId', async () => {
    const deps = buildDeps();
    await deliver(deps, { lat: 1, lng: 2 });

    expect(deps.prisma.booking.findMany).not.toHaveBeenCalled();
  });

  /**
   * A dropped frame costs one map update and the next ping is a second away.
   * Never worth taking the subscriber down for.
   */
  it('survives a database failure without tearing down the subscriber', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockRejectedValue(new Error('db down'));

    await expect(deliver(deps, MOVED)).resolves.toBeUndefined();
    expect(deps.gateway.publish).not.toHaveBeenCalled();
  });
});
