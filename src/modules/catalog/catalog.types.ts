import type { ServiceCategory } from '../../prisma/client';
import type { PublicService } from './service-catalog.service';

/** `Service.commissionType` — the two rate shapes module 8 knows how to apply. */
export const COMMISSION_TYPES = ['percent', 'flat'] as const;
export type CommissionType = (typeof COMMISSION_TYPES)[number];

/**
 * The three booking flows a service may opt into. Stored as three independent
 * booleans on `Service` (ERD v10: supportsInstant / supportsScheduled /
 * supportsRecurring); this alias is only for filtering browse results.
 */
export const BOOKING_TYPES = ['instant', 'scheduled', 'recurring'] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

/**
 * Two levels, and no more: a category is either a root or the child of a root.
 * See CONFLICTS_AND_DECISIONS #10 — the bound lives here rather than in the
 * schema, so raising it later is a validation change, not a migration.
 */
export const MAX_CATEGORY_DEPTH = 2;

/** Maps a booking-type filter onto the column that gates it. */
export const BOOKING_TYPE_COLUMN: Record<
  BookingType,
  'supportsInstant' | 'supportsScheduled' | 'supportsRecurring'
> = {
  instant: 'supportsInstant',
  scheduled: 'supportsScheduled',
  recurring: 'supportsRecurring',
};

/**
 * One node of the assembled browse tree, in Prisma's own types.
 *
 * `CategoryTreeNodeDto` is the Swagger mirror of this and is not
 * interchangeable with it: `flatPrice` is a `Decimal` here and a `string` once
 * serialised (CONFLICTS_AND_DECISIONS #12). Services and controllers use this
 * type; the DTO exists to document what the client actually receives.
 */
export interface CategoryTreeNode extends ServiceCategory {
  children: CategoryTreeNode[];
  /** Commission-stripped — this tree is a customer surface (US-3.2). */
  services: PublicService[];
}
