import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { AdminSosController } from './admin-sos.controller';
import { CustomerSosController } from './customer-sos.controller';
import { SosService } from './sos.service';

/**
 * Module 11 · Safety.
 *
 * ## What this unblocks
 *
 * The customer app had a complete SOS screen — press-and-hold, context
 * snapshot, stand-down, the lot — writing to React state that died with the
 * process. Nothing reached the platform, so an alarm raised at 2am existed
 * only on the phone of the person raising it. This module is the row, the
 * queue and the acknowledgement.
 *
 * ## A leaf, on purpose
 *
 * Imports `IdentityModule` for the guards and nothing else. It deliberately
 * does **not** import `BookingsModule`: an SOS must never fail because a
 * booking lookup did, so the one booking touch in `SosService` goes straight
 * to Prisma inside a `try` that falls through to null. Depending on bookings
 * would make a healthy alarm path contingent on a sick one.
 *
 * ## The gap that is still open
 *
 * No push. `raise()` writes the row and logs at error level; a console polling
 * `GET /admin/sos/alerts` is what turns that into a human being told. The
 * story asks for immediate alerting that bypasses normal queues, and polling
 * is a weaker promise than that — the note on `SosService` marks exactly where
 * a transport slots in when one exists.
 */
@Module({
  imports: [IdentityModule],
  controllers: [CustomerSosController, AdminSosController],
  providers: [SosService],
  exports: [SosService],
})
export class SosModule {}
