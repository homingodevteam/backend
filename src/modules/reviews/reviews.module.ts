import { Module } from '@nestjs/common';
import { S3Module } from '../../storage/s3.module';
import { BookingsModule } from '../bookings/bookings.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminReviewsController } from './admin-reviews.controller';
import { CustomerReviewsController } from './customer-reviews.controller';
import { ProReviewsController } from './pro-reviews.controller';
import { PublicReviewsController } from './public-reviews.controller';
import { ReviewAdvisoryService } from './review-advisory.service';
import { ReviewModerationService } from './review-moderation.service';
import { ReviewsService } from './reviews.service';

/**
 * Module 10 · Reviews — both directions.
 *
 * ## What this module actually unblocks
 *
 * The customer→Pro rating pipeline was already complete except for its first
 * step. `Pro.ratingSum` existed, module 6's nightly job rebuilt it, module 5's
 * `smoothedRating()` fed it into the dispatch tie-break at weight 0.15, and
 * `GET /pros/me/ratings` displayed it. Nothing anywhere created a row. This
 * module is largely one `INSERT` and the guards around it.
 *
 * ## The asymmetry is the design
 *
 * Customer→Pro is public, ranks a Pro, and materially changes their income.
 * Pro→customer is internal, tag-only, and drives nothing automatically. Making
 * the second drive dispatch would mean a household quietly losing service with
 * no explanation and no appeal — so it is not merely unwired, it is unwired
 * everywhere on purpose, and an e2e test walks the live HTTP surface to prove
 * no `reviewerType: 'pro'` row reaches a customer.
 *
 * ## Imports
 *
 * `BookingsModule` for `PlatformSettingsService` — the review window and the
 * photo cap are tunables, not constants. `S3Module` for review photos.
 * Deliberately **not** `ProsModule`: `ProCountersService.recordReview` is the
 * dead ancestor of this module and importing it would give the codebase two
 * writers for one rule.
 */
@Module({
  imports: [IdentityModule, BookingsModule, S3Module],
  controllers: [
    CustomerReviewsController,
    ProReviewsController,
    PublicReviewsController,
    AdminReviewsController,
  ],
  providers: [ReviewsService, ReviewAdvisoryService, ReviewModerationService],
  exports: [ReviewsService, ReviewAdvisoryService],
})
export class ReviewsModule {}
