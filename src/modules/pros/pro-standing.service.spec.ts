import { ProStandingService } from './pro-standing.service';

describe('ProStandingService', () => {
  it('separates ranking rating from reporting-only acceptance', async () => {
    const prisma = {
      pro: {
        findUnique: jest.fn().mockResolvedValue({
          cityId: 'city-1',
          ratingSum: 9,
          ratingCount: 2,
          assignmentsOffered: 4,
          assignmentsAcknowledged: 3,
          acceptanceRate: 0.75,
          completedJobs: 12,
          countersRebuiltAt: null,
        }),
      },
      platformSetting: {
        findMany: jest.fn().mockResolvedValue([
          { key: 'dispatch.ratingPriorMean', value: '4', cityId: null },
          { key: 'dispatch.ratingPriorWeight', value: '5', cityId: null },
        ]),
      },
    };
    const service = new ProStandingService(prisma as never);

    const result = await service.standing('pro-1');

    expect(result.ratingAverage).toBe(4.5);
    expect(result.smoothedRatingScore).toBeCloseTo(29 / 7);
    expect(result.ratingAffectsDispatch).toBe(true);
    expect(result.acceptanceRatePercent).toBe(75);
    expect(result.acceptanceAffectsDispatch).toBe(false);
    expect(result.acceptanceAffectsPay).toBe(false);
  });
});
