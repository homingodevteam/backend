import { bookingRoom, TrackingGateway } from './tracking.gateway';

function buildDeps() {
  const tokens = {
    verifyAccessToken: jest.fn().mockResolvedValue({
      id: 'cust-1',
      actorType: 'customer',
    }),
    resolveCurrentIdentity: jest
      .fn()
      .mockResolvedValue({ id: 'cust-1', actorType: 'customer' }),
  };
  const tracking = {
    getTracking: jest.fn().mockResolvedValue({
      status: 'en_route',
      proId: 'pro-1',
      position: { lat: 22.75, lng: 75.89 },
      isStale: false,
      lastReportedAt: new Date('2026-08-11T12:00:00.000Z'),
      etaMinutes: null,
    }),
  };
  return { tokens, tracking };
}

function build(deps: ReturnType<typeof buildDeps>): TrackingGateway {
  return new TrackingGateway(deps.tokens as never, deps.tracking as never);
}

function aSocket(token?: string) {
  return {
    handshake: { auth: token ? { token } : {}, headers: {} },
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    user: undefined as unknown,
  };
}

/**
 * Drives the handshake exactly as Socket.IO does: middleware first, and only
 * then is the socket usable. Live testing found the bug this shape prevents —
 * auth in `handleConnection` is async, and a client emitting on `connect`
 * arrived before the identity was attached.
 */
async function handshake(
  gateway: TrackingGateway,
  socket: ReturnType<typeof aSocket>,
): Promise<Error | undefined> {
  const use = jest.fn();
  gateway.afterInit({ use } as never);
  const middleware = use.mock.calls[0][0] as (
    s: unknown,
    next: (err?: Error) => void,
  ) => void;

  return new Promise((resolve) => {
    middleware(socket, (err) => resolve(err));
  });
}

describe('TrackingGateway · handshake', () => {
  it('attaches the resolved identity to an authenticated socket', async () => {
    const deps = buildDeps();
    const socket = aSocket('good-token');

    const error = await handshake(build(deps), socket);

    expect(error).toBeUndefined();
    expect(deps.tokens.verifyAccessToken).toHaveBeenCalledWith('good-token');
    expect(socket.user).toMatchObject({ id: 'cust-1' });
  });

  it('accepts the token from an Authorization header too', async () => {
    const deps = buildDeps();
    const socket = aSocket();
    socket.handshake.headers = {
      authorization: 'Bearer header-token',
    };

    await handshake(build(deps), socket);

    expect(deps.tokens.verifyAccessToken).toHaveBeenCalledWith('header-token');
  });

  it('refuses the handshake when no token is presented', async () => {
    const deps = buildDeps();
    const socket = aSocket();

    const error = await handshake(build(deps), socket);

    expect(error).toBeInstanceOf(Error);
    expect(deps.tokens.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('refuses the handshake when the token does not verify', async () => {
    const deps = buildDeps();
    deps.tokens.verifyAccessToken.mockRejectedValue(new Error('expired'));
    const socket = aSocket('bad-token');

    const error = await handshake(build(deps), socket);

    expect(error).toBeInstanceOf(Error);
    expect(socket.user).toBeUndefined();
  });

  /**
   * "Expired" versus "revoked" versus "malformed" tells a prober more than it
   * tells a legitimate client, which reconnects with a fresh token either way.
   */
  it('does not say why authentication failed', async () => {
    const deps = buildDeps();
    deps.tokens.verifyAccessToken.mockRejectedValue(
      new Error('jwt expired at 12:00'),
    );
    const socket = aSocket('bad-token');

    const error = await handshake(build(deps), socket);

    expect(error?.message).toBe('Not authenticated');
    expect(error?.message).not.toMatch(/expired|12:00/);
  });

  /**
   * The race live testing found. `connect` fires as soon as the transport is
   * up, and a sensible client emits immediately — so authentication must be
   * finished before the socket is usable, not merely started.
   */
  it('has the identity attached before any message can arrive', async () => {
    const deps = buildDeps();
    const socket = aSocket('good-token');
    const gateway = build(deps);

    await handshake(gateway, socket);
    // No awaiting anything else: this is the first thing a client does.
    const result = await gateway.track(socket as never, { bookingId: 'bk-1' });

    expect(result).toEqual({ ok: true });
  });
});

describe('TrackingGateway · track', () => {
  it('joins the booking room and answers with the current position', async () => {
    const deps = buildDeps();
    const socket = aSocket('good-token');
    const gateway = build(deps);
    await handshake(gateway, socket);

    const result = await gateway.track(socket as never, { bookingId: 'bk-1' });

    expect(result).toEqual({ ok: true });
    expect(socket.join).toHaveBeenCalledWith(bookingRoom('bk-1'));
    // Answered immediately, so a client connecting mid-journey does not stare
    // at an empty map until the Pro's next ping.
    expect(socket.emit).toHaveBeenCalledWith(
      'tracking',
      expect.objectContaining({ bookingId: 'bk-1', proId: 'pro-1' }),
    );
  });

  /**
   * The whole reason `track` calls through to the tracking service rather than
   * joining the room directly: without an ownership check any authenticated
   * customer could subscribe to any booking id and watch a stranger's Pro.
   */
  it('refuses a booking that is not the caller’s, and does not join', async () => {
    const deps = buildDeps();
    deps.tracking.getTracking.mockRejectedValue(new Error('Booking not found'));
    const socket = aSocket('good-token');
    const gateway = build(deps);
    await handshake(gateway, socket);

    const result = await gateway.track(socket as never, { bookingId: 'bk-x' });

    expect(result).toEqual({ ok: false, error: 'Booking not found' });
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('checks ownership against the socket’s own identity', async () => {
    const deps = buildDeps();
    const socket = aSocket('good-token');
    const gateway = build(deps);
    await handshake(gateway, socket);

    await gateway.track(socket as never, { bookingId: 'bk-1' });

    expect(deps.tracking.getTracking).toHaveBeenCalledWith('cust-1', 'bk-1');
  });

  it('refuses to track on an unauthenticated socket', async () => {
    const deps = buildDeps();
    const socket = aSocket();

    const result = await build(deps).track(socket as never, {
      bookingId: 'bk-1',
    });

    expect(result).toEqual({ ok: false, error: 'Not authenticated' });
    expect(deps.tracking.getTracking).not.toHaveBeenCalled();
  });

  it('requires a bookingId', async () => {
    const deps = buildDeps();
    const socket = aSocket('good-token');
    const gateway = build(deps);
    await handshake(gateway, socket);

    expect(await gateway.track(socket as never, {})).toEqual({
      ok: false,
      error: 'bookingId is required',
    });
  });
});

describe('TrackingGateway · publish', () => {
  it('emits only into the room for that booking', () => {
    const deps = buildDeps();
    const gateway = build(deps);
    const to = jest.fn().mockReturnValue({ emit: jest.fn() });
    gateway.server = { to } as never;

    gateway.publish({
      bookingId: 'bk-1',
      status: 'en_route',
      proId: 'pro-1',
      position: { lat: 22.75, lng: 75.89 },
      isStale: false,
      lastReportedAt: new Date(),
      etaMinutes: null,
    });

    expect(to).toHaveBeenCalledWith(bookingRoom('bk-1'));
  });

  /** Frames can arrive before Socket.IO has attached its server. */
  it('does not throw when no server is attached yet', () => {
    const gateway = build(buildDeps());
    gateway.server = undefined as never;

    expect(() =>
      gateway.publish({
        bookingId: 'bk-1',
        status: 'en_route',
        proId: 'pro-1',
        position: null,
        isStale: true,
        lastReportedAt: null,
        etaMinutes: null,
      }),
    ).not.toThrow();
  });
});
