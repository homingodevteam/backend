import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import { PagedQueryDto, PublicProReviewsDto } from './dto/review.dto';
import { ReviewsService } from './reviews.service';

/**
 * A Pro's public reviews — the only unauthenticated route in module 10.
 *
 * Public because a customer choosing between Pros should not have to hold an
 * account to read what other customers said, and because nothing here
 * discloses anything the Pro's own profile does not.
 *
 * **There is deliberately no `/pros/me/reviews`.** Fastify would bind the
 * literal `me` to `:proId` on this route and serve a 404 for a path that looks
 * like it should work. A Pro reads their own reviews at `/pros/me/ratings`,
 * which module 6 already serves — see CONFLICTS_AND_DECISIONS #56 for what a
 * route collision costs when the tests do not boot the HTTP layer.
 */
@ApiTags('Reviews')
@Controller('pros')
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get(':proId/reviews')
  @ApiOperation({
    summary: 'What customers said about this Pro',
    description:
      "Customer-authored reviews only — the Pro's own ratings **of** " +
      'customers live in the same table and are never served here.\n\n' +
      'A hidden review keeps its star and loses its words: `contentHidden: ' +
      'true` with a null comment and no photos. Moderation is about content, ' +
      'not the score, so `summary.ratingAverage` still counts it.\n\n' +
      "`summary` covers the Pro's whole history; `summary.tagCounts` covers " +
      'the page you asked for.',
  })
  @ApiOkEnvelope(PublicProReviewsDto)
  @ApiErrorEnvelope(HttpStatus.BAD_REQUEST, HttpStatus.NOT_FOUND)
  list(
    @Param('proId') proId: string,
    @Query() query: PagedQueryDto,
  ): Promise<PublicProReviewsDto> {
    return this.reviews.publicForPro(proId, query.page ?? 1, query.limit ?? 20);
  }
}
