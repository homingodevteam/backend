import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Service, ServiceCategory } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminCatalogQueryDto } from './dto/admin-catalog-query.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateServiceDto } from './dto/create-service.dto';
import { SetCommissionDto } from './dto/set-commission.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

/**
 * Every catalog mutation, and the rules that guard them.
 *
 * The rules live here rather than in the controller because two of them —
 * activation gating and the category-depth bound — have to hold whichever
 * route reaches them, and one day a background job will.
 *
 * Nothing here writes an audit row: `AdminAuditLog` is deferred, and the ERD
 * gives neither table an editor column. See CONFLICTS_AND_DECISIONS #2, #9,
 * #14 — "who changed this price and when" is a known, recorded gap.
 */
@Injectable()
export class AdminCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // Categories
  // ------------------------------------------------------------------

  listCategories(query: AdminCatalogQueryDto): Promise<ServiceCategory[]> {
    return this.prisma.serviceCategory.findMany({
      where: query.isActive === undefined ? {} : { isActive: query.isActive },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createCategory(dto: CreateCategoryDto): Promise<ServiceCategory> {
    if (dto.parentCategoryId) {
      await this.assertMayBeParent(dto.parentCategoryId);
    }
    await this.assertSlugFree(dto.slug);

    return this.prisma.serviceCategory.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        parentCategoryId: dto.parentCategoryId ?? null,
        iconUrl: dto.iconUrl ?? null,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateCategory(
    id: string,
    dto: UpdateCategoryDto,
  ): Promise<ServiceCategory> {
    const category = await this.getCategoryOrFail(id);

    // `parentCategoryId` absent = leave alone; explicit null = promote to root.
    if (dto.parentCategoryId !== undefined && dto.parentCategoryId !== null) {
      if (dto.parentCategoryId === id) {
        throw apiError(
          'A category cannot be its own parent',
          HttpStatus.CONFLICT,
        );
      }
      await this.assertMayBeParent(dto.parentCategoryId);
      // Moving a root under another root would push its own children to a
      // third level, which the two-level bound does not allow.
      await this.assertHasNoChildren(
        category.id,
        'This category has child categories, so it cannot become a child itself',
      );
    }

    return this.prisma.serviceCategory.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.iconUrl === undefined ? {} : { iconUrl: dto.iconUrl }),
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
        ...(dto.parentCategoryId === undefined
          ? {}
          : { parentCategoryId: dto.parentCategoryId }),
      },
    });
  }

  /**
   * Deactivating a category hides its whole subtree from browse without
   * touching a single child or service flag. Reactivating it therefore
   * restores exactly the state ops left behind, instead of resurrecting
   * services that were individually retired for their own reasons.
   */
  async setCategoryActivation(
    id: string,
    isActive: boolean,
  ): Promise<ServiceCategory> {
    const category = await this.getCategoryOrFail(id);

    if (isActive && category.parentCategoryId) {
      const parent = await this.prisma.serviceCategory.findUnique({
        where: { id: category.parentCategoryId },
      });
      if (!parent?.isActive) {
        throw apiError(
          'Activate the parent category first — a child of an inactive category is unreachable by browsing',
          HttpStatus.CONFLICT,
          [
            {
              field: 'parentCategoryId',
              message: 'Parent category is inactive',
              code: 'PARENT_CATEGORY_INACTIVE',
            },
          ],
        );
      }
    }

    return this.prisma.serviceCategory.update({
      where: { id },
      data: { isActive },
    });
  }

  /**
   * US-3.8: services must not be orphaned by a category deletion. The database
   * enforces this with `ON DELETE RESTRICT`; this check exists so ops gets a
   * sentence explaining what to move, rather than a constraint-violation 500.
   */
  async deleteCategory(id: string): Promise<void> {
    await this.getCategoryOrFail(id);

    const [childCount, serviceCount] = await Promise.all([
      this.prisma.serviceCategory.count({ where: { parentCategoryId: id } }),
      this.prisma.service.count({ where: { categoryId: id } }),
    ]);

    if (childCount > 0 || serviceCount > 0) {
      throw apiError(
        'This category still holds child categories or services. Move or delete them first.',
        HttpStatus.CONFLICT,
        [
          {
            field: 'id',
            message: `${childCount} child categor${childCount === 1 ? 'y' : 'ies'} and ${serviceCount} service${serviceCount === 1 ? '' : 's'} still reference it`,
            code: 'CATEGORY_NOT_EMPTY',
          },
        ],
      );
    }

    await this.prisma.serviceCategory.delete({ where: { id } });
  }

  // ------------------------------------------------------------------
  // Services
  // ------------------------------------------------------------------

  listServices(query: AdminCatalogQueryDto): Promise<Service[]> {
    return this.prisma.service.findMany({
      where: {
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      },
      orderBy: { name: 'asc' },
    });
  }

  /** Created as a draft. Activation is a separate, gated call — US-3.11. */
  async createService(dto: CreateServiceDto): Promise<Service> {
    await this.getCategoryOrFail(dto.categoryId);

    return this.prisma.service.create({
      data: {
        categoryId: dto.categoryId,
        name: dto.name,
        description: dto.description ?? null,
        durationMinutes: dto.durationMinutes,
        flatPrice: dto.flatPrice,
        supportsInstant: dto.supportsInstant ?? true,
        supportsScheduled: dto.supportsScheduled ?? true,
        supportsRecurring: dto.supportsRecurring ?? false,
        isActive: false,
      },
    });
  }

  /**
   * Price and duration edits deliberately do not cascade anywhere. Bookings
   * already placed keep the price and slot they were sold at — module 4
   * snapshots both at creation (US-3.5, US-3.6).
   */
  async updateService(id: string, dto: UpdateServiceDto): Promise<Service> {
    const service = await this.getServiceOrFail(id);

    if (dto.categoryId) await this.getCategoryOrFail(dto.categoryId);

    // A live service must stay reachable by at least one booking flow, so the
    // same rule that gates activation also gates turning the last flag off.
    const nextFlags = {
      supportsInstant: dto.supportsInstant ?? service.supportsInstant,
      supportsScheduled: dto.supportsScheduled ?? service.supportsScheduled,
      supportsRecurring: dto.supportsRecurring ?? service.supportsRecurring,
    };
    if (service.isActive && !this.hasAnyBookingType(nextFlags)) {
      throw apiError(
        'An active service must support at least one booking type',
        HttpStatus.CONFLICT,
        [
          {
            field: 'supportsInstant',
            message: 'Enable instant, scheduled or recurring',
            code: 'NO_BOOKING_TYPE',
          },
        ],
      );
    }

    return this.prisma.service.update({
      where: { id },
      data: {
        ...(dto.categoryId === undefined ? {} : { categoryId: dto.categoryId }),
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.description === undefined
          ? {}
          : { description: dto.description }),
        ...(dto.durationMinutes === undefined
          ? {}
          : { durationMinutes: dto.durationMinutes }),
        ...(dto.flatPrice === undefined ? {} : { flatPrice: dto.flatPrice }),
        ...nextFlags,
      },
    });
  }

  /**
   * Applies to future completions only. Past `BookingCommission` rows hold
   * their own snapshot, so editing a rate never rewrites what was paid.
   */
  async setCommission(id: string, dto: SetCommissionDto): Promise<Service> {
    await this.getServiceOrFail(id);

    const value = Number(dto.commissionValue);
    if (!Number.isFinite(value) || value < 0) {
      throw apiError(
        'Commission value must be zero or greater',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'commissionValue',
            message: 'Must be a non-negative number',
            code: 'COMMISSION_VALUE_INVALID',
          },
        ],
      );
    }
    if (dto.commissionType === 'percent' && value > 100) {
      throw apiError(
        'A percentage commission cannot exceed 100%',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'commissionValue',
            message: 'Must be between 0 and 100 for a percent rate',
            code: 'COMMISSION_PERCENT_OUT_OF_RANGE',
          },
        ],
      );
    }

    return this.prisma.service.update({
      where: { id },
      data: {
        commissionType: dto.commissionType,
        commissionValue: dto.commissionValue,
      },
    });
  }

  /**
   * The one transition with real teeth.
   *
   * Deactivation is unconditional — it stops new bookings and leaves committed
   * ones untouched (US-3.7). Activation must clear three gates, because each
   * failure only surfaces later, at a point where it is expensive: no
   * commission rate means an unpaid Pro (US-3.11), an inactive category means
   * a service nobody can browse to, and no booking type means a service no
   * flow can reach.
   */
  async setServiceActivation(id: string, isActive: boolean): Promise<Service> {
    const service = await this.getServiceOrFail(id);

    if (!isActive) {
      return this.prisma.service.update({
        where: { id },
        data: { isActive: false },
      });
    }

    if (!service.commissionType || service.commissionValue === null) {
      throw apiError(
        'Set a commission rate before activating this service',
        HttpStatus.CONFLICT,
        [
          {
            field: 'commissionType',
            message:
              'A service with no commission rate would complete jobs the Pro is never paid for',
            code: 'COMMISSION_RATE_MISSING',
          },
        ],
      );
    }

    const category = await this.getCategoryOrFail(service.categoryId);
    if (!category.isActive) {
      throw apiError(
        'Activate the parent category first — this service would be unreachable by browsing',
        HttpStatus.CONFLICT,
        [
          {
            field: 'categoryId',
            message: 'Category is inactive',
            code: 'CATEGORY_INACTIVE',
          },
        ],
      );
    }

    if (!this.hasAnyBookingType(service)) {
      throw apiError(
        'An active service must support at least one booking type',
        HttpStatus.CONFLICT,
        [
          {
            field: 'supportsInstant',
            message: 'Enable instant, scheduled or recurring',
            code: 'NO_BOOKING_TYPE',
          },
        ],
      );
    }

    return this.prisma.service.update({
      where: { id },
      data: { isActive: true },
    });
  }

  // ------------------------------------------------------------------
  // Shared guards
  // ------------------------------------------------------------------

  private hasAnyBookingType(flags: {
    supportsInstant: boolean;
    supportsScheduled: boolean;
    supportsRecurring: boolean;
  }): boolean {
    return (
      flags.supportsInstant ||
      flags.supportsScheduled ||
      flags.supportsRecurring
    );
  }

  /**
   * Enforces the two-level bound: only a root may be a parent. Combined with
   * the self-parent check, that makes cycles unreachable without walking the
   * tree — a category can never point at anything but a root, and a root
   * points at nothing.
   */
  private async assertMayBeParent(parentId: string): Promise<void> {
    const parent = await this.prisma.serviceCategory.findUnique({
      where: { id: parentId },
    });
    if (!parent) {
      throw apiError('Parent category not found', HttpStatus.NOT_FOUND);
    }
    if (parent.parentCategoryId) {
      throw apiError(
        'The category tree is two levels deep — a sub-category cannot have children of its own',
        HttpStatus.CONFLICT,
        [
          {
            field: 'parentCategoryId',
            message: 'Parent must be a top-level category',
            code: 'CATEGORY_DEPTH_EXCEEDED',
          },
        ],
      );
    }
  }

  private async assertHasNoChildren(
    id: string,
    message: string,
  ): Promise<void> {
    const childCount = await this.prisma.serviceCategory.count({
      where: { parentCategoryId: id },
    });
    if (childCount > 0) {
      throw apiError(message, HttpStatus.CONFLICT, [
        {
          field: 'parentCategoryId',
          message: `${childCount} child categor${childCount === 1 ? 'y' : 'ies'} would end up three levels deep`,
          code: 'CATEGORY_DEPTH_EXCEEDED',
        },
      ]);
    }
  }

  private async assertSlugFree(slug: string): Promise<void> {
    const existing = await this.prisma.serviceCategory.findUnique({
      where: { slug },
    });
    if (existing) {
      throw apiError('That slug is already in use', HttpStatus.CONFLICT, [
        { field: 'slug', message: 'Already taken', code: 'SLUG_TAKEN' },
      ]);
    }
  }

  private async getCategoryOrFail(id: string): Promise<ServiceCategory> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id },
    });
    if (!category) throw apiError('Category not found', HttpStatus.NOT_FOUND);
    return category;
  }

  private async getServiceOrFail(id: string): Promise<Service> {
    const service = await this.prisma.service.findUnique({ where: { id } });
    if (!service) throw apiError('Service not found', HttpStatus.NOT_FOUND);
    return service;
  }
}
