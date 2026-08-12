import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, TrainingModule } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import { apiError } from '../../common/utils';
import { readAnswerKey } from './quiz-grading';
import { CurriculumService } from './curriculum.service';
import type {
  AdminTrainingModuleDto,
  CreateTrainingModuleDto,
  ProTrainingReportDto,
  TrainingModuleQueryDto,
  UpdateTrainingModuleDto,
} from './dto/training.dto';

/**
 * Admin-side training content, and the one screen that shows a Pro's standing
 * against it.
 *
 * The database enforces the content rules with CHECKs; this class enforces
 * them again so the answer is a readable 400 with a field name rather than a
 * constraint violation an admin cannot act on.
 */
@Injectable()
export class TrainingCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly curriculum: CurriculumService,
  ) {}

  // ------------------------------------------------------------------
  // Content
  // ------------------------------------------------------------------

  async list(query: TrainingModuleQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.TrainingModuleWhereInput = {
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.contentType ? { contentType: query.contentType } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.isMandatory === undefined
        ? {}
        : { isMandatory: query.isMandatory }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.trainingModule.findMany({
        where,
        orderBy: [{ categoryId: 'asc' }, { sortOrder: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.trainingModule.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.toAdminDto(row)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async create(dto: CreateTrainingModuleDto): Promise<AdminTrainingModuleDto> {
    await this.assertCategory(dto.categoryId);
    this.assertContent(dto.contentType, dto.contentKey, dto.contentUrl);
    this.assertAnswerKey(dto.contentType, dto.quizAnswerKey);

    const created = await this.prisma.trainingModule.create({
      data: {
        categoryId: dto.categoryId,
        title: dto.title,
        description: dto.description ?? null,
        contentType: dto.contentType,
        contentKey: dto.contentKey ?? null,
        contentUrl: dto.contentUrl ?? null,
        contentBytes: dto.contentBytes ?? null,
        quizAnswerKey: dto.quizAnswerKey ?? undefined,
        quizPassPercent: dto.quizPassPercent ?? null,
        isMandatory: dto.isMandatory ?? false,
        durationMinutes: dto.durationMinutes ?? null,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
    return this.toAdminDto(created);
  }

  /**
   * Edit a module, bumping `version` when the content itself moved.
   *
   * The bump is automatic rather than a field an admin can forget. A replaced
   * video with an unchanged version number is invisible to every phone that
   * already cached it — they keep playing the old procedure and nothing in the
   * system knows.
   *
   * Renaming a module or changing its sort order is not a content change and
   * does not bump.
   */
  async update(
    id: string,
    dto: UpdateTrainingModuleDto,
  ): Promise<AdminTrainingModuleDto> {
    const existing = await this.prisma.trainingModule.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Training module not found');

    if (dto.categoryId) await this.assertCategory(dto.categoryId);

    const contentType = dto.contentType ?? existing.contentType;
    // A field the caller omitted keeps its stored value; a field they sent as
    // null clears it. `undefined` and `null` mean different things here and
    // collapsing them would make it impossible to switch a module from a
    // hosted URL to an uploaded file.
    const contentKey =
      dto.contentKey === undefined
        ? dto.contentUrl === undefined
          ? existing.contentKey
          : null
        : dto.contentKey;
    const contentUrl =
      dto.contentUrl === undefined
        ? dto.contentKey === undefined
          ? existing.contentUrl
          : null
        : dto.contentUrl;

    this.assertContent(contentType, contentKey, contentUrl);

    const answerKey =
      dto.quizAnswerKey === undefined
        ? existing.quizAnswerKey
        : dto.quizAnswerKey;
    this.assertAnswerKey(contentType, answerKey);

    const contentMoved =
      contentKey !== existing.contentKey || contentUrl !== existing.contentUrl;

    const updated = await this.prisma.trainingModule.update({
      where: { id },
      data: {
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.title ? { title: dto.title } : {}),
        ...(dto.description === undefined
          ? {}
          : { description: dto.description }),
        contentType,
        contentKey,
        contentUrl,
        ...(dto.contentBytes === undefined
          ? {}
          : { contentBytes: dto.contentBytes }),
        ...(dto.quizAnswerKey === undefined
          ? {}
          : { quizAnswerKey: dto.quizAnswerKey }),
        ...(dto.quizPassPercent === undefined
          ? {}
          : { quizPassPercent: dto.quizPassPercent }),
        ...(dto.isMandatory === undefined
          ? {}
          : { isMandatory: dto.isMandatory }),
        ...(dto.durationMinutes === undefined
          ? {}
          : { durationMinutes: dto.durationMinutes }),
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
        ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
        ...(contentMoved ? { version: { increment: 1 } } : {}),
      },
    });
    return this.toAdminDto(updated);
  }

  async createContentUploadUrl(
    contentType: string,
  ): Promise<{ contentKey: string; uploadUrl: string; expiresIn: number }> {
    const { key, uploadUrl, expiresIn } = await this.s3.createUploadUrl(
      'training/content',
      contentType,
    );
    return { contentKey: key, uploadUrl, expiresIn };
  }

  // ------------------------------------------------------------------
  // One Pro
  // ------------------------------------------------------------------

  /**
   * A Pro's whole training picture: per-service eligibility, every module, and
   * their offline sessions.
   *
   * `gateEnforced` is on the response rather than left implicit. An admin
   * reading `eligible: false` needs to know whether that is currently blocking
   * anything, and while `training.gateActivation` is off — which is how it
   * ships — it is not.
   */
  async proReport(proId: string): Promise<ProTrainingReportDto> {
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      select: { id: true, fullName: true, cityId: true },
    });
    if (!pro) throw new NotFoundException('Pro not found');

    const proServices = await this.prisma.proService.findMany({
      where: { proId },
      include: { service: { select: { name: true } } },
    });

    const services = await Promise.all(
      proServices.map(async (proService) => {
        const missingModules = await this.curriculum.missingMandatory(
          proId,
          proService.serviceId,
        );
        return {
          serviceId: proService.serviceId,
          serviceName: proService.service.name,
          isActive: proService.isActive,
          eligible: missingModules.length === 0,
          missingModules,
        };
      }),
    );

    const [curriculum, sessions, gateEnforced] = await Promise.all([
      this.curriculum.curriculum(proId),
      this.curriculum.sessions(proId),
      this.curriculum.gateEnforced(pro.cityId),
    ]);

    return {
      proId: pro.id,
      fullName: pro.fullName,
      gateEnforced,
      services,
      modules: curriculum.modules,
      sessions,
    };
  }

  /**
   * Clear an exhausted quiz lock.
   *
   * The reason the cap can exist at all. A retry limit with no way back is a
   * Pro permanently unable to be activated for a trade, over a quiz they may
   * have failed because the questions were wrong.
   *
   * Attempts reset to zero rather than the lock alone being lifted — giving
   * back one attempt would put them straight back at the cap on the next
   * failure. `bestQuizScore` survives, because it is a record of what they
   * actually achieved.
   */
  async resetQuiz(proId: string, moduleId: string): Promise<void> {
    const progress = await this.prisma.proTrainingProgress.findUnique({
      where: { proId_moduleId: { proId, moduleId } },
    });
    if (!progress) {
      throw new NotFoundException('This Pro has no attempt at that module');
    }

    await this.prisma.proTrainingProgress.update({
      where: { proId_moduleId: { proId, moduleId } },
      data: { quizAttempts: 0, lockedAt: null },
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private async assertCategory(categoryId: string): Promise<void> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
    });
    if (!category) throw new NotFoundException('Service category not found');
  }

  private assertContent(
    contentType: string,
    contentKey: string | null | undefined,
    contentUrl: string | null | undefined,
  ): void {
    const hasKey = !!contentKey;
    const hasUrl = !!contentUrl;
    if (hasKey === hasUrl) {
      throw apiError(
        'A module needs exactly one content source',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'contentKey',
            message: hasKey
              ? 'Set contentKey or contentUrl, not both'
              : 'Set contentKey or contentUrl',
            code: 'CONTENT_SOURCE_INVALID',
          },
        ],
      );
    }
  }

  private assertAnswerKey(contentType: string, value: unknown): void {
    if (contentType !== 'quiz') return;
    if (readAnswerKey(value) === null) {
      throw apiError(
        'A quiz needs a valid answer key',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'quizAnswerKey',
            message:
              'Shape: { "q1": "b", "q2": ["a","c"] }. Grading is server-side, ' +
              'so without this the score would mean nothing.',
            code: 'ANSWER_KEY_INVALID',
          },
        ],
      );
    }
  }

  private toAdminDto(module: TrainingModule): AdminTrainingModuleDto {
    return {
      id: module.id,
      categoryId: module.categoryId,
      title: module.title,
      description: module.description,
      contentType: module.contentType as AdminTrainingModuleDto['contentType'],
      contentKey: module.contentKey,
      contentUrl: module.contentUrl,
      contentBytes: module.contentBytes,
      version: module.version,
      quizAnswerKey: module.quizAnswerKey,
      quizPassPercent: module.quizPassPercent,
      isMandatory: module.isMandatory,
      durationMinutes: module.durationMinutes,
      sortOrder: module.sortOrder,
      isActive: module.isActive,
    };
  }
}
