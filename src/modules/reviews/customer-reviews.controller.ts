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
  CreateCustomerReviewDto,
  RequestReviewPhotoUploadDto,
  ReviewDto,
  ReviewPhotoUploadUrlDto,
} from './dto/review.dto';
import { ReviewsService } from './reviews.service';

/**
 * The customer's review of a finished job.
 *
 * This is the write path that makes feature 15 live. Everything downstream of
 * it was already built — the counters, the nightly rebuild, the dispatch
 * tie-break, the Pro's own ratings screen — and sat idle because nothing
 * created a row.
 */
@ApiTags('Reviews')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('customer')
@Controller('bookings/:bookingId/review')
export class CustomerReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post()
  @ApiOperation({
    summary: 'Review the Pro who did this job',
    description:
      'Completed bookings only, by the customer on the booking, once, and ' +
      'within `review.windowDays` (14) of completion.\n\n' +
      '**Submitting twice returns the first review with 200, not an error.** ' +
      'The overwhelmingly common cause is a double tap or a retry on a poor ' +
      'connection, and answering that with a conflict teaches people to try ' +
      'again. Reviews are immutable once written — there is no edit endpoint, ' +
      "which is what keeps the Pro's rating exact without a " +
      'compensating-update path.\n\n' +
      'This rating is public and feeds how much work the Pro is offered.',
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
    @Body() dto: CreateCustomerReviewDto,
  ): Promise<ReviewDto> {
    return this.reviews.createCustomerReview(user.id, bookingId, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'My review of this job',
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
    return this.reviews.forBooking(user.id, bookingId, 'customer');
  }

  @Post('photos/upload-url')
  @ApiOperation({
    summary: 'Presigned URL for a photo of the finished work',
    description:
      "PUT the file to `uploadUrl`, then send `photoKey` in the review's " +
      '`photoKeys`. Keys are namespaced per booking; one issued for another ' +
      'job is rejected.\n\n' +
      'Objects are private — the review response returns short-lived signed ' +
      'GETs, never a public URL.',
  })
  @ApiCreatedEnvelope(ReviewPhotoUploadUrlDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  uploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bookingId') bookingId: string,
    @Body() dto: RequestReviewPhotoUploadDto,
  ): Promise<ReviewPhotoUploadUrlDto> {
    return this.reviews.createPhotoUploadUrl(
      user.id,
      bookingId,
      dto.contentType,
    );
  }
}
