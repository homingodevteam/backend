import { Module } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module';
import { S3Module } from '../../storage/s3.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomersModule } from '../customers/customers.module';
import { IdentityModule } from '../identity/identity.module';
import { ProsModule } from '../pros/pros.module';
import { AdminBookingsController } from './admin-bookings.controller';
import { BookingCancellationService } from './booking-cancellation.service';
import { BookingChatService } from './booking-chat.service';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingStateService } from './booking-state.service';
import { BookingTrackingService } from './booking-tracking.service';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { PlatformSettingsService } from './platform-settings.service';
import { ProBookingsController } from './pro-bookings.controller';
import { DISPATCH_PORT, NoOpDispatchService } from './ports/dispatch.port';
import { NoOpPaymentsService, PAYMENTS_PORT } from './ports/payments.port';
import { RecurringPlansService } from './recurring-plans.service';

/**
 * Module 4 · Booking & Job Lifecycle — the spine.
 *
 * Owns `Booking`, `RecurringPlan`, `BookingStatusEvent`, `ChatMessage` and
 * `JobPhotoProof`.
 *
 * Two of its dependencies do not exist yet, so they are consumed through ports
 * this module owns rather than blocking on them:
 *
 * - {@link DISPATCH_PORT} → module 5. Bound to a no-op that leaves bookings in
 *   `assigning`; ops assigns by hand until the engine exists.
 * - {@link PAYMENTS_PORT} → module 7. Bound to a no-op that refuses online
 *   orders outright. **Cash bookings need neither**, which is why the whole
 *   lifecycle runs end to end today.
 *
 * Swapping in the real modules later means changing these two `provide`
 * lines and nothing else.
 */
@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    CustomersModule,
    ProsModule,
    S3Module,
    // Live tracking reads the Pro GEO index module 6 writes to; nothing about
    // a live position is ever stored on the booking.
    RedisModule,
  ],
  controllers: [
    BookingsController,
    ProBookingsController,
    AdminBookingsController,
  ],
  providers: [
    BookingsService,
    BookingStateService,
    BookingLifecycleService,
    BookingCancellationService,
    BookingChatService,
    BookingTrackingService,
    RecurringPlansService,
    PlatformSettingsService,
    { provide: DISPATCH_PORT, useClass: NoOpDispatchService },
    { provide: PAYMENTS_PORT, useClass: NoOpPaymentsService },
  ],
  // PlatformSettingsService and the dispatch port are exported so module 5
  // can read tunables and register the real engine into the delegate.
  exports: [
    BookingsService,
    BookingStateService,
    PlatformSettingsService,
    DISPATCH_PORT,
  ],
})
export class BookingsModule {}
