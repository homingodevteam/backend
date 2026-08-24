import { ProBreaksService } from './pro-breaks.service';

/**
 * A Pro row, with only the fields breaks care about.
 *
 * Cast at the call site rather than typed as a full `Pro`: the service reads
 * five columns and a complete fixture would be forty lines of noise that says
 * nothing about what is under test.
 */
function proRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pro-1',
    isAvailable: true,
    breakStartedAt: null,
    breakEndsAt: null,
    scheduledBreakStartAt: null,
    scheduledBreakEndAt: null,
    ...overrides,
  };
}

function buildDeps(pro = proRow()) {
  const prisma = {
    pro: {
      findUnique: jest.fn().mockResolvedValue(pro),
      // Echoes the patch back over the row, the way the real update does.
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...pro, ...data }),
        ),
    },
  };

  return { prisma, service: new ProBreaksService(prisma as never) };
}

describe('ProBreaksService · toStatus', () => {
  /**
   * A break ends by the clock passing it, so nothing can be stored that says
   * whether one is running — it would be wrong from that instant onward.
   */
  it('derives isOnBreak from the deadline rather than a stored flag', () => {
    const now = new Date('2026-08-22T12:00:00.000Z');
    const status = ProBreaksService.toStatus(
      proRow({
        breakStartedAt: new Date('2026-08-22T11:50:00.000Z'),
        breakEndsAt: new Date('2026-08-22T12:20:00.000Z'),
      }) as never,
      now,
    );

    expect(status.isOnBreak).toBe(true);
    expect(status.secondsRemaining).toBe(20 * 60);
  });

  /**
   * The case that makes the expiry-with-no-scheduler design work: an elapsed
   * timestamp is simply not a break, with nothing having written to the row.
   */
  it('reads an elapsed break as over, and hides its stale timestamps', () => {
    const now = new Date('2026-08-22T13:00:00.000Z');
    const status = ProBreaksService.toStatus(
      proRow({
        breakStartedAt: new Date('2026-08-22T11:50:00.000Z'),
        breakEndsAt: new Date('2026-08-22T12:20:00.000Z'),
      }) as never,
      now,
    );

    expect(status.isOnBreak).toBe(false);
    expect(status.secondsRemaining).toBe(0);
    expect(status.breakEndsAt).toBeNull();
    expect(status.breakStartedAt).toBeNull();
  });

  /** A booked window is reported whether or not a break is running now. */
  it('reports a scheduled window independently of a running break', () => {
    const start = new Date('2026-08-22T14:00:00.000Z');
    const end = new Date('2026-08-22T14:30:00.000Z');

    const status = ProBreaksService.toStatus(
      proRow({
        scheduledBreakStartAt: start,
        scheduledBreakEndAt: end,
      }) as never,
      new Date('2026-08-22T12:00:00.000Z'),
    );

    expect(status.isOnBreak).toBe(false);
    expect(status.scheduledBreakStartAt).toEqual(start);
    expect(status.scheduledBreakEndAt).toEqual(end);
  });
});

describe('ProBreaksService · start', () => {
  it('writes a deadline the requested number of minutes out', async () => {
    const { prisma, service } = buildDeps();

    await service.start('pro-1', { minutes: 30 });

    const { data } = prisma.pro.update.mock.calls[0][0] as {
      data: { breakStartedAt: Date; breakEndsAt: Date };
    };

    expect(data.breakEndsAt.getTime() - data.breakStartedAt.getTime()).toBe(
      30 * 60_000,
    );
  });

  it('defaults to a thirty-minute break', async () => {
    const { prisma, service } = buildDeps();

    await service.start('pro-1', {});

    const { data } = prisma.pro.update.mock.calls[0][0] as {
      data: { breakStartedAt: Date; breakEndsAt: Date };
    };

    expect(data.breakEndsAt.getTime() - data.breakStartedAt.getTime()).toBe(
      30 * 60_000,
    );
  });

  /**
   * Refused rather than extended. A double tap would otherwise silently turn
   * a 30-minute break into an hour, with nothing on screen saying so.
   */
  it('refuses to start a second break over a running one', async () => {
    const { service } = buildDeps(
      proRow({ breakEndsAt: new Date(Date.now() + 10 * 60_000) }),
    );

    await expect(service.start('pro-1', {})).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409 }),
    });
  });

  /** An elapsed break is not a running one, so a new break is allowed. */
  it('allows a new break once the previous one has elapsed', async () => {
    const { prisma, service } = buildDeps(
      proRow({ breakEndsAt: new Date(Date.now() - 60_000) }),
    );

    await expect(service.start('pro-1', {})).resolves.toBeDefined();
    expect(prisma.pro.update).toHaveBeenCalled();
  });

  /**
   * `isAvailable` is the admin's roster flag and this service never writes it
   * (US-6.12). A Pro who is not rostered has no dispatch to pause, and a
   * running timer that changes nothing would be the app lying to them.
   */
  it('refuses a break for a Pro who is off duty', async () => {
    const { service } = buildDeps(proRow({ isAvailable: false }));

    await expect(service.start('pro-1', {})).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409 }),
    });
  });

  it('never writes the admin-owned availability flag', async () => {
    const { prisma, service } = buildDeps();

    await service.start('pro-1', { minutes: 15 });

    const { data } = prisma.pro.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).not.toHaveProperty('isAvailable');
  });
});

describe('ProBreaksService · end', () => {
  it('clears both columns rather than back-dating the deadline', async () => {
    const { prisma, service } = buildDeps(
      proRow({
        breakStartedAt: new Date(),
        breakEndsAt: new Date(Date.now() + 10 * 60_000),
      }),
    );

    await service.end('pro-1');

    expect(prisma.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { breakStartedAt: null, breakEndsAt: null },
    });
  });

  /**
   * This is the "put me back to work" button. Failing it because the timer had
   * already run out would be refusing to do something that is already true.
   */
  it('succeeds when no break is running', async () => {
    const { service } = buildDeps();

    await expect(service.end('pro-1')).resolves.toMatchObject({
      isOnBreak: false,
    });
  });
});

describe('ProBreaksService · schedule', () => {
  const inAnHour = () => new Date(Date.now() + 60 * 60_000);

  it('stores a valid future window', async () => {
    const { prisma, service } = buildDeps();
    const startAt = inAnHour();
    const endAt = new Date(startAt.getTime() + 30 * 60_000);

    await service.schedule('pro-1', {
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
    });

    expect(prisma.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: {
        scheduledBreakStartAt: startAt,
        scheduledBreakEndAt: endAt,
      },
    });
  });

  it('refuses a window that ends before it starts', async () => {
    const { service } = buildDeps();
    const startAt = inAnHour();

    await expect(
      service.schedule('pro-1', {
        startAt: startAt.toISOString(),
        endAt: new Date(startAt.getTime() - 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 400 }),
    });
  });

  /**
   * Dispatch has already been through a past window, so storing one would tell
   * a Pro their afternoon was protected when nothing was.
   */
  it('refuses a window that has already passed', async () => {
    const { service } = buildDeps();
    const endAt = new Date(Date.now() - 60 * 60_000);

    await expect(
      service.schedule('pro-1', {
        startAt: new Date(endAt.getTime() - 30 * 60_000).toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 400 }),
    });
  });

  /** Past the cap this stops being a break and becomes a roster. */
  it('refuses a window longer than the maximum break', async () => {
    const { service } = buildDeps();
    const startAt = inAnHour();

    await expect(
      service.schedule('pro-1', {
        startAt: startAt.toISOString(),
        endAt: new Date(startAt.getTime() + 90 * 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 400 }),
    });
  });

  it('refuses a window booked further ahead than a day', async () => {
    const { service } = buildDeps();
    const startAt = new Date(Date.now() + 30 * 60 * 60_000);

    await expect(
      service.schedule('pro-1', {
        startAt: startAt.toISOString(),
        endAt: new Date(startAt.getTime() + 30 * 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 400 }),
    });
  });
});

describe('ProBreaksService · cancelScheduled', () => {
  /** Cancelling lunch must not also end the break being taken right now. */
  it('drops the booked window and leaves a running break alone', async () => {
    const { prisma, service } = buildDeps();

    await service.cancelScheduled('pro-1');

    expect(prisma.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { scheduledBreakStartAt: null, scheduledBreakEndAt: null },
    });

    const { data } = prisma.pro.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).not.toHaveProperty('breakEndsAt');
  });
});
