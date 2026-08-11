import { Injectable, NotFoundException } from '@nestjs/common';
import type { Review } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SetReviewVisibilityDto } from './dto/review.dto';

/**
 * Admin-side reads and moderation of the reviews customers leave on a job.
 *
 * The Pro's own view of the same rows lives in ProStandingService, which
 * blanks the text of a hidden review. This service does the opposite: an
 * admin deciding whether a hide was justified has to see what was written.
 */
@Injectable()
export class ProReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  listForPro(proId: string): Promise<Review[]> {
    return this.prisma.review.findMany({
      where: { proId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Hiding suppresses the comment and tags, never the star rating.
   *
   * That is not an oversight: ProCountersService.rebuildAll() recomputes
   * ratingSum/ratingCount from every review row with no isHidden filter, so
   * decrementing here would be silently undone on the next rebuild — and
   * worse, it would let moderation quietly launder a Pro's score.
   */
  async setVisibility(
    proId: string,
    reviewId: string,
    dto: SetReviewVisibilityDto,
  ): Promise<Review> {
    const review = await this.prisma.review.findFirst({
      where: { id: reviewId, proId },
    });
    if (!review) throw new NotFoundException('Review not found');

    return this.prisma.review.update({
      where: { id: reviewId },
      data: {
        isHidden: dto.isHidden,
        hiddenReason: dto.isHidden ? (dto.reason?.trim() ?? null) : null,
      },
    });
  }
}
