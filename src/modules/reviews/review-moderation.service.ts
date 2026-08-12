import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Review } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import { apiError } from '../../common/utils';
import {
  emptyTagCounts,
  readPhotoKeys,
  readTags,
  type ReviewerType,
} from './reviews.types';
import type {
  AdminReviewDto,
  AdminReviewQueryDto,
  CustomerFeedbackDto,
} from './dto/review.dto';

/**
 * Moderation, and the two admin screens that make the collected signal
 * actionable.
 *
 * ## Hiding removes the content, never the score
 *
 * A one-star review with an abusive sentence in it is still a one-star
 * experience. Dropping the rating along with the words would let moderation
 * quietly launder a Pro's average — and would permanently split the live
 * counter from module 6's nightly rebuild, which counts rows and knows nothing
 * about what a human decided was unpublishable.
 *
 * ## Admin reads are not redacted
 *
 * `toAdminDto` returns the text of a hidden review. That is the point of the
 * queue: someone has to be able to see what was hidden in order to decide it
 * was hidden wrongly. `contentHidden` says which state it is in.
 */
@Injectable()
export class ReviewModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  async list(
    query: AdminReviewQueryDto,
  ): Promise<{ data: AdminReviewDto[]; meta: Record<string, number> }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ReviewWhereInput = {
      ...(query.reviewerType ? { reviewerType: query.reviewerType } : {}),
      ...(query.proId ? { proId: query.proId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.maxRating === undefined
        ? {}
        : { rating: { lte: query.maxRating } }),
      ...(query.isHidden === undefined ? {} : { isHidden: query.isHidden }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count({ where }),
    ]);

    return {
      data: await Promise.all(rows.map((row) => this.toAdminDto(row))),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async hide(
    reviewId: string,
    adminId: string,
    reason: string,
  ): Promise<AdminReviewDto> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
    });
    if (!review) throw new NotFoundException('Review not found');
    if (review.isHidden) {
      throw apiError('This review is already hidden', HttpStatus.CONFLICT);
    }

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        isHidden: true,
        hiddenReason: reason,
        hiddenByAdminId: adminId,
        hiddenAt: new Date(),
      },
    });
    return this.toAdminDto(updated);
  }

  /**
   * Unhide, keeping the trail.
   *
   * `hiddenReason`, `hiddenByAdminId` and `hiddenAt` are **cleared**, because
   * the database CHECK ties them to `isHidden` and a stale reason on a visible
   * review reads as a live decision. The record that it happened lives in the
   * admin audit log, which is where the history of a decision belongs — not
   * smeared across the row it was about.
   */
  async unhide(reviewId: string): Promise<AdminReviewDto> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
    });
    if (!review) throw new NotFoundException('Review not found');
    if (!review.isHidden) {
      throw apiError('This review is not hidden', HttpStatus.CONFLICT);
    }

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        isHidden: false,
        hiddenReason: null,
        hiddenByAdminId: null,
        hiddenAt: null,
      },
    });
    return this.toAdminDto(updated);
  }

  /**
   * What ops sees about a household — the screen that answers "why would I
   * block this customer".
   *
   * The lever itself already exists: `Customer.isBlocked` and
   * `CUSTOMER_MODERATE` shipped in module 2. Ops could always act; they could
   * not see the pattern that would justify it. **Nothing in module 10 sets
   * `isBlocked`** — collecting `unsafe` tags and acting on none of them is
   * worse than not collecting them, but so is a block nobody chose.
   */
  async customerFeedback(customerId: string): Promise<CustomerFeedbackDto> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        fullName: true,
        isBlocked: true,
        ratingSum: true,
        ratingCount: true,
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const [rows, completedBookings] = await Promise.all([
      this.prisma.review.findMany({
        where: { customerId, reviewerType: 'pro' },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.booking.count({
        where: { customerId, status: 'completed' },
      }),
    ]);

    const tagCounts = emptyTagCounts('pro');
    for (const row of rows) {
      for (const tag of readTags(row.tags, 'pro')) tagCounts[tag] += 1;
    }

    return {
      customerId: customer.id,
      fullName: customer.fullName,
      isBlocked: customer.isBlocked,
      ratingAverage:
        customer.ratingCount === 0
          ? null
          : customer.ratingSum / customer.ratingCount,
      ratingCount: customer.ratingCount,
      completedBookings,
      tagCounts,
      recent: await Promise.all(
        rows.slice(0, 20).map((row) => this.toAdminDto(row)),
      ),
    };
  }

  private async toAdminDto(review: Review): Promise<AdminReviewDto> {
    const reviewerType = review.reviewerType as ReviewerType;
    const photoUrls = await Promise.all(
      readPhotoKeys(review.photoUrls).map(
        async (key) => (await this.s3.createViewUrl(key)).viewUrl,
      ),
    );

    return {
      id: review.id,
      bookingId: review.bookingId,
      proId: review.proId,
      customerId: review.customerId,
      reviewerType,
      rating: review.rating,
      comment: review.comment,
      tags: readTags(review.tags, reviewerType),
      photoUrls,
      contentHidden: review.isHidden,
      hiddenReason: review.hiddenReason,
      hiddenByAdminId: review.hiddenByAdminId,
      hiddenAt: review.hiddenAt,
      createdAt: review.createdAt,
    };
  }
}
