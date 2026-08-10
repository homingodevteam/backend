import { ProCountersService } from './pro-counters.service';

function buildDeps() {
  const prisma = {
    assignmentCandidate: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    booking: { findUnique: jest.fn(), update: jest.fn() },
    bookingStatusEvent: { findFirst: jest.fn(), create: jest.fn() },
    review: { findUnique: jest.fn(), create: jest.fn() },
    pro: { update: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(prisma),
  );
  const redis = {
    setIfAbsent: jest.fn().mockResolvedValue(true),
    del: jest.fn(),
  };
  const config = { get: jest.fn().mockReturnValue('false') };
  return { prisma, redis, config };
}

describe('ProCountersService', () => {
  it('increments an offer exactly once for one assignment attempt', async () => {
    const deps = buildDeps();
    deps.prisma.assignmentCandidate.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'candidate-1' });
    const service = new ProCountersService(
      deps.prisma as never,
      deps.redis as never,
      deps.config as never,
    );

    await service.recordOffer('booking-1', 1, 'pro-1', 4.2, 3);
    await service.recordOffer('booking-1', 1, 'pro-1', 4.2, 3);

    expect(deps.prisma.assignmentCandidate.create).toHaveBeenCalledTimes(1);
    expect(deps.prisma.pro.update).toHaveBeenCalledTimes(1);
    expect(deps.prisma.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { assignmentsOffered: { increment: 1 } },
    });
  });

  it('stores raw acknowledgement evidence and recomputes the fraction', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      proId: 'pro-1',
      assignmentOutcome: 'pending_ack',
      ackDeadlineAt: new Date(Date.now() + 60_000),
    });
    deps.prisma.bookingStatusEvent.findFirst.mockResolvedValue(null);
    deps.prisma.pro.update
      .mockResolvedValueOnce({
        assignmentsOffered: 4,
        assignmentsAcknowledged: 3,
      })
      .mockResolvedValueOnce({});
    const service = new ProCountersService(
      deps.prisma as never,
      deps.redis as never,
      deps.config as never,
    );

    await service.recordAcknowledgement('booking-1', 'pro-1');

    expect(deps.prisma.bookingStatusEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'assignment_acknowledged',
        actorId: 'pro-1',
      }),
    });
    expect(deps.prisma.pro.update).toHaveBeenLastCalledWith({
      where: { id: 'pro-1' },
      data: { acceptanceRate: 0.75 },
    });
  });
});
