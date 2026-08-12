import { Inject, Logger, Module } from '@nestjs/common';
import { S3Module } from '../../storage/s3.module';
import { BookingsModule } from '../bookings/bookings.module';
import { IdentityModule } from '../identity/identity.module';
import { ProsModule } from '../pros/pros.module';
import {
  NoOpTrainingGateService,
  TRAINING_GATE_PORT,
} from '../pros/ports/training-gate.port';
import { AdminTrainingController } from './admin-training.controller';
import { CurriculumService } from './curriculum.service';
import { ProTrainingController } from './pro-training.controller';
import { TrainingCatalogService } from './training-catalog.service';
import { TrainingGateAdapter } from './training-gate.adapter';
import { TrainingSessionsService } from './training-sessions.service';

/**
 * Module 10 · Training — making Pros competent, and being able to show it.
 *
 * Owns `TrainingModule`, `ProTrainingProgress`, `OfflineTrainingSession` and
 * `OfflineTrainingAttendance`.
 *
 * ## Nothing imports this module
 *
 * It is a leaf. The one thing it gives the rest of the system — the
 * mandatory-module check on service activation — goes out through a port that
 * `ProsModule` owns, so module 6 compiles, boots and passes its tests whether
 * or not this module exists. Seventh use of that pattern here.
 *
 * ## The gate registers, and stays shut off
 *
 * Registration is unconditional; **enforcement is not**.
 * `training.gateActivation` defaults to `false`, so the adapter returns
 * immediately until somebody switches it on for a city whose trades actually
 * have their mandatory content loaded. Turning it on first would block every
 * Pro activation on the platform with an error that explains nothing.
 *
 * ## Imports
 *
 * `BookingsModule` for `PlatformSettingsService` — the attempt cap, the pass
 * mark and the gate switch are tunables, not constants. `S3Module` for content
 * upload and the long-lived content URLs. `ProsModule` for the port delegate.
 */
@Module({
  imports: [IdentityModule, BookingsModule, ProsModule, S3Module],
  controllers: [ProTrainingController, AdminTrainingController],
  providers: [
    CurriculumService,
    TrainingCatalogService,
    TrainingSessionsService,
    TrainingGateAdapter,
  ],
  exports: [CurriculumService],
})
export class TrainingModule {
  private readonly logger = new Logger(TrainingModule.name);

  constructor(
    @Inject(TRAINING_GATE_PORT) gate: NoOpTrainingGateService,
    adapter: TrainingGateAdapter,
  ) {
    gate.register(adapter);
    this.logger.log(
      'Training gate wired to module 6 — enforcement still depends on ' +
        'training.gateActivation, which defaults to off.',
    );
  }
}
