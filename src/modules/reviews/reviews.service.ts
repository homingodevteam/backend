import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Booking, Prisma, Review } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import { apiError } from '../../common/utils';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import {
  REVIEW_SETTINGS,
  emptyTagCounts,
  readPhotoKeys,
  readTags,
  type ReviewerType,
} from './reviews.types';
import type {
  CreateCustomerReviewDto,
  CreateProReviewDto,
  PublicReviewDto,
  ReviewDto,
  ReviewSummaryDto,
} from './dto/review.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Writing and reading reviews, in both directions.
 *
 * ## The one rule that governs the whole file
 *
 * A `reviews` row carries **both participants** — `proId` and `customerId` —
 * and `reviewerType` alone says which of them wrote it. Every query here
 * filters on it, and every write states it explicitly rather than relying on
 * the column default. Getting this wrong is not a display bug: it is
 * CONFLICTS_AND_DECISIONS #61, where a Pro's opinion of a customer lands in
 * the Pro's own public rating.
 *
 * ## Counters move with the row, in one transaction
 *
 * A customer's review increments `Pro.ratingSum`; a Pro's increments
 * `Customer.ratingSum` — always the **other** party. Both happen inside the
 * insert's transaction, so the counter and the rows behind it cannot disagree;
 * module 6's nightly rebuild is what proves they didn't.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly settings: PlatformSettingsService,
  ) {}

  // ------------------------------------------------------------------
  // Writing
  // ------------------------------------------------------------------

  /** Customer → Pro. Public, and the only signal that changes a Pro's standing. */
  async createCustomerReview(
    customerId: string,
    bookingId: string,
    dto: CreateCustomerReviewDto,
  ): Promise<ReviewDto> {
    const booking = await this.reviewableBooking(bookingId);
    if (booking.customerId !== customerId) {
      throw apiError(
        'Only the customer on this booking may review it',
        HttpStatus.FORBIDDEN,
      );
    }

    const photoKeys = dto.photoKeys ?? [];
    if (photoKeys.length > 0) {
      const maxPhotos = await this.settings.getNumber(
        REVIEW_SETTINGS.maxPhotos.key,
        REVIEW_SETTINGS.maxPhotos.fallback,
      );
      if (photoKeys.length > maxPhotos) {
        throw apiError(`At most ${maxPhotos} photos`, HttpStatus.BAD_REQUEST, [
          {
            field: 'photoKeys',
            message: `At most ${maxPhotos}`,
            code: 'TOO_MANY_PHOTOS',
          },
        ]);
      }
      // Namespaced per booking, like every other upload in this codebase, so a
      // key issued for one job can never be attached to another.
      const prefix = this.photoPrefix(bookingId);
      const stray = photoKeys.find((key) => !key.startsWith(prefix));
      if (stray) {
        throw apiError(
          'That photo key does not belong to this booking',
          HttpStatus.BAD_REQUEST,
          [
            {
              field: 'photoKeys',
              message: 'Keys must come from this booking’s upload-url call',
              code: 'PHOTO_KEY_INVALID',
            },
          ],
        );
      }
    }

    const review = await this.insert({
      booking,
      reviewerType: 'customer',
      rating: dto.rating,
      comment: dto.comment ?? null,
      tags: dto.tags ?? [],
      photoKeys,
    });
    return this.toDto(review);
  }

  /**
   * Pro → customer. Internal, tag-only, and it drives nothing.
   *
   * `CreateProReviewDto` has no `comment` property, so an unexpected one is
   * rejected by the global `forbidNonWhitelisted` validation pipe rather than
   * quietly dropped — a Pro who typed a paragraph should be told it was not
   * stored, not left believing ops will read it.
   */
  async createProReview(
    proId: string,
    bookingId: string,
    dto: CreateProReviewDto,
  ): Promise<ReviewDto> {
    const booking = await this.reviewableBooking(bookingId);
    if (booking.proId !== proId) {
      throw apiError(
        'Only the Pro assigned to this booking may review it',
        HttpStatus.FORBIDDEN,
      );
    }

    const review = await this.insert({
      booking,
      reviewerType: 'pro',
      rating: dto.rating,
      comment: null,
      tags: dto.tags ?? [],
      photoKeys: [],
    });
    return this.toDto(review);
  }

  async createPhotoUploadUrl(
    customerId: string,
    bookingId: string,
    contentType: string,
  ): Promise<{ photoKey: string; uploadUrl: string; expiresIn: number }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking || booking.customerId !== customerId) {
      throw new NotFoundException('Booking not found');
    }
    const { key, uploadUrl, expiresIn } = await this.s3.createUploadUrl(
      this.photoPrefix(bookingId).replace(/\/$/, ''),
      contentType,
    );
    return { photoKey: key, uploadUrl, expiresIn };
  }

  // ------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------

  /** One party's own review of a booking, or null if they have not written it. */
  async forBooking(
    participantId: string,
    bookingId: string,
    reviewerType: ReviewerType,
  ): Promise<ReviewDto | null> {
    const review = await this.prisma.review.findUnique({
      where: { bookingId_reviewerType: { bookingId, reviewerType } },
    });
    if (!review) return null;

    const owner =
      reviewerType === 'customer' ? review.customerId : review.proId;
    if (owner !== participantId)
      throw new NotFoundException('Review not found');

    return this.toDto(review);
  }

  /**
   * The public list on a Pro's profile.
   *
   * `reviewerType: 'customer'` is not a filter that could be forgotten
   * harmlessly — without it this endpoint publishes what Pros said about
   * households. `reviews.e2e-spec.ts` walks the real HTTP surface and fails if
   * a `pro` row appears on any customer-facing route.
   */
  async publicForPro(
    proId: string,
    page: number,
    limit: number,
  ): Promise<{
    summary: ReviewSummaryDto;
    data: PublicReviewDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const where: Prisma.ReviewWhereInput = {
      proId,
      reviewerType: 'customer',
    };

    const [rows, total, buckets] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { customer: { select: { fullName: true } } },
      }),
      this.prisma.review.count({ where }),
      this.prisma.review.groupBy({
        by: ['rating'],
        where,
        _count: { _all: true },
      }),
    ]);

    // Tag counts come from the same page, not the whole history: totalling
    // every tag a Pro ever received needs its own aggregate, and a profile
    // screen does not justify one.
    const tagCounts = emptyTagCounts('customer');
    let sum = 0;
    for (const bucket of buckets) sum += bucket.rating * bucket._count._all;

    const ratingBreakdown: Record<string, number> = {
      '1': 0,
      '2': 0,
      '3': 0,
      '4': 0,
      '5': 0,
    };
    for (const bucket of buckets) {
      ratingBreakdown[String(bucket.rating)] = bucket._count._all;
    }

    const data = await Promise.all(
      rows.map(async (row) => {
        for (const tag of readTags(row.tags, 'customer')) {
          if (tag in tagCounts) tagCounts[tag] += 1;
        }
        const base = await this.toDto(row);
        return {
          ...base,
          // First name only. A full name beside a home-service review on a
          // public page identifies a household to anyone who reads it.
          customerName: row.customer.fullName?.split(' ')[0] ?? null,
        };
      }),
    );

    return {
      summary: {
        ratingAverage: total === 0 ? null : sum / total,
        ratingCount: total,
        ratingBreakdown,
        tagCounts,
      },
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * The insert, its counter and its guards — one transaction, one advisory
   * lock per booking **per direction**.
   *
   * Locking on the direction as well as the booking means a customer and a Pro
   * reviewing the same job at the same moment do not serialise behind each
   * other; they touch different rows and different counters.
   */
  private async insert(input: {
    booking: Booking;
    reviewerType: ReviewerType;
    rating: number;
    comment: string | null;
    tags: string[];
    photoKeys: string[];
  }): Promise<Review> {
    const { booking, reviewerType } = input;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`review:${booking.id}:${reviewerType}`}, 0))`;

      /**
       * A repeat submission returns the row that is already there, 200.
       *
       * Not a conflict: the overwhelmingly common cause is a double tap or a
       * retry on a flaky connection, and answering that with an error trains
       * people to submit twice. The rating is unchanged either way — reviews
       * are immutable except to moderation, which is what keeps `ratingSum`
       * exact without a compensating-update path.
       */
      const existing = await tx.review.findUnique({
        where: {
          bookingId_reviewerType: { bookingId: booking.id, reviewerType },
        },
      });
      if (existing) return existing;

      const created = await tx.review.create({
        data: {
          bookingId: booking.id,
          customerId: booking.customerId,
          proId: booking.proId!,
          reviewerType,
          rating: input.rating,
          comment: input.comment,
          tags: input.tags,
          photoUrls: input.photoKeys,
        },
      });

      // Always the OTHER party. This is the line #61 is about.
      if (reviewerType === 'customer') {
        await tx.pro.update({
          where: { id: booking.proId! },
          data: {
            ratingSum: { increment: input.rating },
            ratingCount: { increment: 1 },
          },
        });
      } else {
        await tx.customer.update({
          where: { id: booking.customerId },
          data: {
            ratingSum: { increment: input.rating },
            ratingCount: { increment: 1 },
          },
        });
      }

      return created;
    });
  }

  /**
   * A booking that can still be reviewed: completed, assigned, and inside the
   * window.
   *
   * The window closes both directions at once. A rating recalled a month later
   * is about a memory, and the Pro it lands on may have changed how they work
   * twice since.
   */
  private async reviewableBooking(bookingId: string): Promise<Booking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      // A booking carries no `cityId` of its own — the city is the address's,
      // and the window is a per-city tunable like every other setting here.
      include: { address: { select: { cityId: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    if (booking.status !== 'completed' || !booking.proId) {
      throw apiError(
        'Only a completed booking can be reviewed',
        HttpStatus.CONFLICT,
      );
    }

    const windowDays = await this.settings.getNumber(
      REVIEW_SETTINGS.windowDays.key,
      REVIEW_SETTINGS.windowDays.fallback,
      booking.address.cityId,
    );
    const closedAt = new Date(
      (booking.completedAt ?? booking.updatedAt).getTime() +
        windowDays * DAY_MS,
    );
    if (new Date() > closedAt) {
      throw apiError(
        `Reviews close ${windowDays} days after a job is completed`,
        HttpStatus.CONFLICT,
      );
    }

    return booking;
  }

  private photoPrefix(bookingId: string): string {
    return `bookings/${bookingId}/review/`;
  }

  /**
   * A stored row as a client sees it.
   *
   * Hidden means the **content** is withheld and the score is not — a one-star
   * review with an abusive sentence is still a one-star experience, and
   * dropping the rating would let moderation quietly launder an average.
   * `ProStandingService.ratings()` has always done exactly this, which is the
   * precedent rather than a coincidence.
   */
  private async toDto(review: Review): Promise<ReviewDto> {
    const reviewerType = review.reviewerType as ReviewerType;
    const photoKeys = review.isHidden ? [] : readPhotoKeys(review.photoUrls);

    const photoUrls = await Promise.all(
      photoKeys.map(async (key) => (await this.s3.createViewUrl(key)).viewUrl),
    );

    return {
      id: review.id,
      bookingId: review.bookingId,
      reviewerType,
      rating: review.rating,
      comment: review.isHidden ? null : review.comment,
      tags: review.isHidden ? [] : readTags(review.tags, reviewerType),
      photoUrls,
      contentHidden: review.isHidden,
      createdAt: review.createdAt,
    };
  }
}
