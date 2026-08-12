import { HttpStatus } from '@nestjs/common';
import { ReviewsService } from './reviews.service';

const NOW = new Date('2026-08-12T09:00:00.000Z');

function buildDeps() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    review: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'rev-1',
          createdAt: NOW,
          isHidden: false,
          comment: null,
          photoUrls: [],
          ...args.data,
        }),
      ),
    },
    pro: { update: jest.fn().mockResolvedValue({}) },
    customer: { update: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    booking: {
      findUnique: jest.fn().mockResolvedValue(aBooking()),
      count: jest.fn().mockResolvedValue(0),
    },
    review: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const s3 = {
    createUploadUrl: jest.fn().mockResolvedValue({
      key: 'bookings/book-1/review/abc',
      uploadUrl: 'https://s3/put',
      expiresIn: 300,
    }),
    createViewUrl: jest
      .fn()
      .mockResolvedValue({ viewUrl: 'https://s3/get', expiresIn: 300 }),
  };

  const settings = {
    getNumber: jest.fn((_key: string, fallback: number) =>
      Promise.resolve(fallback),
    ),
  };

  return { prisma, tx, s3, settings };
}

function build(deps: ReturnType<typeof buildDeps>): ReviewsService {
  return new ReviewsService(
    deps.prisma as never,
    deps.s3 as never,
    deps.settings as never,
  );
}

function aBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'book-1',
    customerId: 'cust-1',
    proId: 'pro-1',
    status: 'completed',
    completedAt: new Date('2026-08-11T09:00:00.000Z'),
    updatedAt: new Date('2026-08-11T09:00:00.000Z'),
    address: { cityId: 'city-1' },
    ...overrides,
  };
}

beforeAll(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});
afterAll(() => {
  jest.useRealTimers();
});

// =====================================================================
// The direction rule — CONFLICTS_AND_DECISIONS #61
// =====================================================================
//
// A `reviews` row carries BOTH participants. `reviewerType` alone says which
// of them wrote it, and the counter always moves on the OTHER one.

describe('direction', () => {
  it('a customer’s review raises the Pro’s rating', async () => {
    const deps = buildDeps();

    await build(deps).createCustomerReview('cust-1', 'book-1', { rating: 5 });

    expect(deps.tx.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { ratingSum: { increment: 5 }, ratingCount: { increment: 1 } },
    });
    expect(deps.tx.customer.update).not.toHaveBeenCalled();
  });

  /**
   * The one that matters. The Pro is the AUTHOR of this row and their `proId`
   * is on it — if the counter followed `proId` rather than the direction, a
   * Pro flagging a difficult household would rate themselves down.
   */
  it('a Pro’s review raises the CUSTOMER’s rating, never their own', async () => {
    const deps = buildDeps();

    await build(deps).createProReview('pro-1', 'book-1', {
      rating: 2,
      tags: ['no_access'],
    });

    expect(deps.tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust-1' },
      data: { ratingSum: { increment: 2 }, ratingCount: { increment: 1 } },
    });
    expect(deps.tx.pro.update).not.toHaveBeenCalled();
  });

  it('writes reviewerType explicitly rather than leaning on the column default', async () => {
    const deps = buildDeps();
    const service = build(deps);

    await service.createCustomerReview('cust-1', 'book-1', { rating: 4 });
    await service.createProReview('pro-1', 'book-1', { rating: 3 });

    expect(deps.tx.review.create.mock.calls[0][0].data.reviewerType).toBe(
      'customer',
    );
    expect(deps.tx.review.create.mock.calls[1][0].data.reviewerType).toBe(
      'pro',
    );
  });

  it('locks per direction, so the two parties do not serialise behind each other', async () => {
    const deps = buildDeps();
    const service = build(deps);

    await service.createCustomerReview('cust-1', 'book-1', { rating: 4 });
    await service.createProReview('pro-1', 'book-1', { rating: 4 });

    const [first, second] = deps.tx.$executeRaw.mock.calls;
    expect(first[1]).toBe('review:book-1:customer');
    expect(second[1]).toBe('review:book-1:pro');
  });
});

// =====================================================================
// Who, when, and how many times
// =====================================================================

describe('eligibility', () => {
  it('refuses a booking that is not completed', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aBooking({ status: 'in_progress' }),
    );

    await expect(
      build(deps).createCustomerReview('cust-1', 'book-1', { rating: 5 }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('refuses a completed booking nobody was assigned to', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(aBooking({ proId: null }));

    await expect(
      build(deps).createCustomerReview('cust-1', 'book-1', { rating: 5 }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('refuses a customer reviewing somebody else’s job', async () => {
    const deps = buildDeps();

    await expect(
      build(deps).createCustomerReview('cust-2', 'book-1', { rating: 5 }),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });

  it('refuses a Pro reviewing a job they were not sent to', async () => {
    const deps = buildDeps();

    await expect(
      build(deps).createProReview('pro-2', 'book-1', { rating: 5 }),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });

  /**
   * A rating recalled a month later is about a memory, and the Pro it lands on
   * may have changed how they work twice since.
   */
  it('closes both directions once the window has passed', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aBooking({ completedAt: new Date('2026-07-01T09:00:00.000Z') }),
    );

    await expect(
      build(deps).createCustomerReview('cust-1', 'book-1', { rating: 5 }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    await expect(
      build(deps).createProReview('pro-1', 'book-1', { rating: 5 }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('reads the window as a per-city setting', async () => {
    const deps = buildDeps();

    await build(deps).createCustomerReview('cust-1', 'book-1', { rating: 5 });

    expect(deps.settings.getNumber).toHaveBeenCalledWith(
      'review.windowDays',
      14,
      'city-1',
    );
  });

  /**
   * A double tap is the overwhelmingly common cause, and answering it with a
   * conflict teaches people to submit twice. The counter must not move again.
   */
  it('returns the existing review on a repeat submission, without counting it twice', async () => {
    const deps = buildDeps();
    deps.tx.review.findUnique.mockResolvedValue({
      id: 'rev-1',
      bookingId: 'book-1',
      reviewerType: 'customer',
      rating: 5,
      comment: 'Great',
      tags: [],
      photoUrls: [],
      isHidden: false,
      createdAt: NOW,
    });

    const result = await build(deps).createCustomerReview('cust-1', 'book-1', {
      rating: 1,
    });

    expect(result.rating).toBe(5);
    expect(deps.tx.review.create).not.toHaveBeenCalled();
    expect(deps.tx.pro.update).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Photos
// =====================================================================

describe('photos', () => {
  it('rejects a key issued for another booking', async () => {
    const deps = buildDeps();

    await expect(
      build(deps).createCustomerReview('cust-1', 'book-1', {
        rating: 5,
        photoKeys: ['bookings/book-99/review/abc'],
      }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it('rejects more photos than the setting allows', async () => {
    const deps = buildDeps();
    deps.settings.getNumber.mockResolvedValue(2);

    await expect(
      build(deps).createCustomerReview('cust-1', 'book-1', {
        rating: 5,
        photoKeys: ['a', 'b', 'c'].map(
          (name) => `bookings/book-1/review/${name}`,
        ),
      }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it('namespaces an upload key under its booking', async () => {
    const deps = buildDeps();

    await build(deps).createPhotoUploadUrl('cust-1', 'book-1', 'image/jpeg');

    expect(deps.s3.createUploadUrl).toHaveBeenCalledWith(
      'bookings/book-1/review',
      'image/jpeg',
    );
  });
});

// =====================================================================
// Moderation, as a reader sees it
// =====================================================================

describe('hidden content', () => {
  it('withholds the words and photos, and keeps the star', async () => {
    const deps = buildDeps();
    deps.prisma.review.findUnique.mockResolvedValue({
      id: 'rev-1',
      bookingId: 'book-1',
      customerId: 'cust-1',
      proId: 'pro-1',
      reviewerType: 'customer',
      rating: 1,
      comment: 'abusive',
      tags: ['late'],
      photoUrls: ['bookings/book-1/review/a'],
      isHidden: true,
      createdAt: NOW,
    });

    const review = await build(deps).forBooking('cust-1', 'book-1', 'customer');

    expect(review).toMatchObject({
      rating: 1,
      comment: null,
      tags: [],
      photoUrls: [],
      contentHidden: true,
    });
    // Not even a signed URL is minted for a hidden photo.
    expect(deps.s3.createViewUrl).not.toHaveBeenCalled();
  });

  it('does not hand one party the other’s review', async () => {
    const deps = buildDeps();
    deps.prisma.review.findUnique.mockResolvedValue({
      id: 'rev-1',
      bookingId: 'book-1',
      customerId: 'cust-1',
      proId: 'pro-1',
      reviewerType: 'customer',
      rating: 5,
      comment: null,
      tags: [],
      photoUrls: [],
      isHidden: false,
      createdAt: NOW,
    });

    await expect(
      build(deps).forBooking('cust-2', 'book-1', 'customer'),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });
});

// =====================================================================
// The public list
// =====================================================================

describe('publicForPro', () => {
  /**
   * Not a filter that could be forgotten harmlessly — without it this endpoint
   * publishes what Pros said about households.
   */
  it('asks only for customer-authored rows', async () => {
    const deps = buildDeps();

    await build(deps).publicForPro('pro-1', 1, 20);

    for (const call of [
      deps.prisma.review.findMany.mock.calls[0][0],
      deps.prisma.review.count.mock.calls[0][0],
      deps.prisma.review.groupBy.mock.calls[0][0],
    ]) {
      expect(call.where).toMatchObject({
        proId: 'pro-1',
        reviewerType: 'customer',
      });
    }
  });

  it('averages from the whole history, not the page', async () => {
    const deps = buildDeps();
    deps.prisma.review.count.mockResolvedValue(4);
    deps.prisma.review.groupBy.mockResolvedValue([
      { rating: 5, _count: { _all: 3 } },
      { rating: 1, _count: { _all: 1 } },
    ]);

    const { summary } = await build(deps).publicForPro('pro-1', 1, 20);

    expect(summary.ratingAverage).toBe(4);
    expect(summary.ratingCount).toBe(4);
    expect(summary.ratingBreakdown).toEqual({
      '1': 1,
      '2': 0,
      '3': 0,
      '4': 0,
      '5': 3,
    });
  });

  it('reports no average rather than zero for a Pro nobody has rated', async () => {
    const deps = buildDeps();

    const { summary } = await build(deps).publicForPro('pro-1', 1, 20);

    // 0 would render as a one-star Pro. Null is the honest answer.
    expect(summary.ratingAverage).toBeNull();
  });

  it('shows a first name only', async () => {
    const deps = buildDeps();
    deps.prisma.review.count.mockResolvedValue(1);
    deps.prisma.review.findMany.mockResolvedValue([
      {
        id: 'rev-1',
        bookingId: 'book-1',
        reviewerType: 'customer',
        rating: 5,
        comment: 'Great',
        tags: ['punctual'],
        photoUrls: [],
        isHidden: false,
        createdAt: NOW,
        customer: { fullName: 'Anita Sharma' },
      },
    ]);

    const { data } = await build(deps).publicForPro('pro-1', 1, 20);

    expect(data[0].customerName).toBe('Anita');
  });
});
