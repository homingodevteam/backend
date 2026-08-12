import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import type { TrainingGatePort } from '../pros/ports/training-gate.port';
import { CurriculumService } from './curriculum.service';

/**
 * The mandatory-module check, on the training side of module 6's port.
 *
 * ## It is off by default and that is not a placeholder
 *
 * `training.gateActivation` ships `false`, exactly as
 * `geo.enforceAreaServiceAvailability` does and for the same reason: a gate
 * switched on before the content behind it exists blocks every Pro activation
 * on the platform, and the resulting error tells an admin nothing about why.
 * Turn it on — globally or per city — once a trade's mandatory modules are
 * actually loaded.
 *
 * ## The 409 names what is missing
 *
 * Titles, not a count. An ops admin who cannot activate a Pro needs to know
 * which two videos they have not watched; anything less is a support ticket
 * that has to be reverse-engineered from the database.
 */
@Injectable()
export class TrainingGateAdapter implements TrainingGatePort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly curriculum: CurriculumService,
  ) {}

  async assertEligible(proId: string, serviceId: string): Promise<void> {
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      select: { cityId: true },
    });
    // No Pro is module 6's problem to report, not this gate's — its own
    // lookup will 404 a moment later with a better message.
    if (!pro) return;

    if (!(await this.curriculum.gateEnforced(pro.cityId))) return;

    const missing = await this.curriculum.missingMandatory(proId, serviceId);
    if (missing.length === 0) return;

    throw apiError(
      `This Pro has ${missing.length} mandatory training module(s) outstanding for this trade`,
      HttpStatus.CONFLICT,
      missing.map((title) => ({
        field: 'serviceId',
        message: title,
        code: 'TRAINING_INCOMPLETE',
      })),
    );
  }
}
