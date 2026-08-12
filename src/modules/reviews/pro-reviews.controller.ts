import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import {
  CreateProReviewDto,
  CustomerAdvisoryDto,
  ReviewDto,
} from './dto/review.dto';
import { ReviewAdvisoryService } from './review-advisory.service';
import { ReviewsService } from './reviews.service';

/**
 * The other direction — what the Pro says about the household, and what the
 * household's history says to the Pro.
 *
 * Neither route here is public and neither ever will be. The customer cannot
 * see their own rating, cannot see the tags, and is not told the advisory
 * exists — which is a deliberate cost of the design, not an oversight. The
 * alternative, showing it, turns every low rating into a dispute the Pro has
 * to have at the door.
 */
@ApiTags('Pro — Reviews')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('pro')
@Controller('pros/me/bookings/:bookingId')
export class ProReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly advisory: ReviewAdvisoryService,
  ) {}

  @Post('review')
  @ApiOperation({
    summary: 'Rate this customer',
    description:
      'Tags and a rating. **There is no comment field** — sending one is a ' +
      '400, not a silently dropped value. Free text about a household, held ' +
      'internally and shown to the next stranger arriving at their door, is ' +
      'the one thing this design refuses.\n\n' +
      'This is internal. It reaches ops and the next Pro dispatched to the ' +
      'same customer, never the customer themselves, and **it drives nothing ' +
      'automatically** — not dispatch, not pricing, not their ability to ' +
      'book. Acting on a pattern is a human decision with a name on it.',
  })
  @ApiCreatedEnvelope(ReviewDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bookingId') bookingId: string,
    @Body() dto: CreateProReviewDto,
  ): Promise<ReviewDto> {
    return this.reviews.createProReview(user.id, bookingId, dto);
  }

  @Get('review')
  @ApiOperation({
    summary: 'My rating of this customer',
    description: '`null` when it has not been written yet.',
  })
  @ApiOkEnvelope(ReviewDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  mine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bookingId') bookingId: string,
  ): Promise<ReviewDto | null> {
    return this.reviews.forBooking(user.id, bookingId, 'pro');
  }

  @Get('customer-advisory')
  @ApiOperation({
    summary: 'What previous Pros found at this address',
    description:
      'For the job card, before you set off.\n\n' +
      'Aggregated and tag-only: **no prior Pro is named and there is no free ' +
      'text**, so you learn "three people could not get in" rather than who ' +
      'said it or in whose words. `ratingCount: 0` is the normal case and ' +
      'means nothing has been reported — not that the household is a risk.\n\n' +
      'Show this as context, not as a verdict.',
  })
  @ApiOkEnvelope(CustomerAdvisoryDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  customerAdvisory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bookingId') bookingId: string,
  ): Promise<CustomerAdvisoryDto> {
    return this.advisory.forBooking(user.id, bookingId);
  }
}
