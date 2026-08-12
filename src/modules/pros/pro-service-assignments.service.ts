import {
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ProService } from '../../prisma/client';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { ServiceCatalogService } from '../catalog/service-catalog.service';
import { AssignServiceDto } from './dto/assign-service.dto';
import { UpdateProServiceDto } from './dto/update-pro-service.dto';
import {
  TRAINING_GATE_PORT,
  type TrainingGatePort,
} from './ports/training-gate.port';

@Injectable()
export class ProServiceAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ServiceCatalogService,
    @Inject(TRAINING_GATE_PORT)
    private readonly trainingGate: TrainingGatePort,
  ) {}

  list(proId: string): Promise<ProService[]> {
    return this.prisma.proService.findMany({ where: { proId } });
  }

  async assign(proId: string, dto: AssignServiceDto): Promise<ProService> {
    // Until module 3 existed this accepted any string, so a typo produced a
    // Pro competent at a service that does not exist — invisible until
    // dispatch failed to find anyone. The database now enforces the same
    // thing with a foreign key; this call is what turns that into a 404 with
    // a readable message instead of a constraint violation.
    //
    // Deliberately resolves rather than asserts bookable: ops legitimately
    // trains Pros on a service that is still a draft, ahead of its launch.
    await this.catalog.getServiceOrFail(dto.serviceId);

    const existing = await this.prisma.proService.findUnique({
      where: { proId_serviceId: { proId, serviceId: dto.serviceId } },
    });
    if (existing) {
      throw apiError(
        'This Pro is already assigned to this service',
        HttpStatus.CONFLICT,
      );
    }

    // Feature 6 of module 10. The row is created already active, so this IS
    // the activation — there is no later step to check. No-op unless module 10
    // is present and `training.gateActivation` is on, which it is not by
    // default: a gate switched on before the content exists blocks every
    // onboarding on the platform.
    await this.trainingGate.assertEligible(proId, dto.serviceId);

    return this.prisma.proService.create({
      data: {
        proId,
        serviceId: dto.serviceId,
        proficiency: dto.proficiency ?? 'trainee',
        isActive: true,
      },
    });
  }

  async update(
    proId: string,
    serviceId: string,
    dto: UpdateProServiceDto,
  ): Promise<ProService> {
    const proService = await this.prisma.proService.findUnique({
      where: { proId_serviceId: { proId, serviceId } },
    });
    if (!proService)
      throw new NotFoundException('Pro is not assigned to this service');

    // Only on the transition INTO active. Re-saving an already-active row, or
    // deactivating one, must never be blocked by training — suspending a Pro
    // from a service is a safety action and cannot depend on their coursework.
    if (dto.isActive === true && !proService.isActive) {
      await this.trainingGate.assertEligible(proId, serviceId);
    }

    return this.prisma.proService.update({
      where: { proId_serviceId: { proId, serviceId } },
      data: dto,
    });
  }
}
