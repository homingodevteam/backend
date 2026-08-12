import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import {
  AdminReviewDto,
  AdminReviewQueryDto,
  CustomerFeedbackDto,
  HideReviewDto,
} from './dto/review.dto';
import { ReviewModerationService } from './review-moderation.service';

/**
 * Moderation, and the screen that makes a household's history readable.
 *
 * Admin reads are **not redacted** — a hidden review still returns its text
 * here, because deciding something was hidden wrongly requires seeing it.
 * `contentHidden` says which state a row is in.
 */
@ApiTags('Admin — Reviews')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin')
export class AdminReviewsController {
  constructor(private readonly moderation: ReviewModerationService) {}

  @Get('reviews')
  @RequirePermissions(PermissionCode.REVIEW_MODERATE)
  @ApiOperation({
    summary: 'Browse reviews in both directions',
    description:
      'The moderation queue is `?isHidden=false&maxRating=2`; the Pro-side ' +
      'signal is `?reviewerType=pro`.\n\n' +
      'Omitting `reviewerType` returns both directions, so read `reviewerType` ' +
      'on every row before displaying it — `proId` and `customerId` are the ' +
      'two **participants**, not the author and the subject.',
  })
  @ApiOkEnvelope(AdminReviewDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(@Query() query: AdminReviewQueryDto) {
    return this.moderation.list(query);
  }

  @Post('reviews/:id/hide')
  @RequirePermissions(PermissionCode.REVIEW_MODERATE)
  @ApiOperation({
    summary: 'Hide a review’s content',
    description:
      '**The rating still counts.** Hiding removes the words and the photos ' +
      'and leaves the star — a one-star review with an abusive sentence in it ' +
      'is still a one-star experience, and dropping the score would let ' +
      "moderation quietly launder a Pro's average as well as split the live " +
      'counter from the nightly rebuild, which counts rows.\n\n' +
      'The reason and your identity are stored on the row. Use this for abuse ' +
      "and for a photo that exposes a customer's home — not for a review " +
      'that is merely unflattering.',
  })
  @ApiOkEnvelope(AdminReviewDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  hide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: HideReviewDto,
  ): Promise<AdminReviewDto> {
    return this.moderation.hide(id, user.id, dto.reason);
  }

  @Post('reviews/:id/unhide')
  @RequirePermissions(PermissionCode.REVIEW_MODERATE)
  @ApiOperation({
    summary: 'Restore a hidden review',
    description:
      'Clears the reason and the attribution, because a stale reason beside a ' +
      'visible review reads as a live decision. That it happened is in the ' +
      'admin audit log, which is where the history of a decision belongs.',
  })
  @ApiOkEnvelope(AdminReviewDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  unhide(@Param('id') id: string): Promise<AdminReviewDto> {
    return this.moderation.unhide(id);
  }

  @Get('customers/:id/feedback')
  @RequirePermissions(PermissionCode.REVIEW_MODERATE)
  @ApiOperation({
    summary: 'What Pros have reported about this household',
    description:
      'The pattern behind a decision: six jobs, three `no_access`, average ' +
      '2.7.\n\n' +
      '**Nothing here acts.** `PATCH /admin/customers/:id/block` has existed ' +
      'since module 2 and is still the only way a customer loses service — ' +
      'this screen exists because ops could always act and could not see why ' +
      'they should. What a repeated `unsafe` tag warrants is a policy ' +
      'question, and answering it automatically would mean a household ' +
      'quietly losing service from a signal it cannot see, with no notice and ' +
      'no appeal.',
  })
  @ApiOkEnvelope(CustomerFeedbackDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  customerFeedback(@Param('id') id: string): Promise<CustomerFeedbackDto> {
    return this.moderation.customerFeedback(id);
  }
}
