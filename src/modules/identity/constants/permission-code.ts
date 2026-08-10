/**
 * Every permission code any admin-mutating endpoint in this pass checks.
 * `Role.permissionCodes` holds a subset of these as a json string array —
 * add here first whenever a new guarded admin endpoint is introduced.
 */
export const PermissionCode = {
  ROLE_MANAGE: 'identity.role.manage',
  ADMIN_USER_MANAGE: 'identity.adminUser.manage',
  CUSTOMER_MODERATE: 'customer.moderate',
  PRO_APPLICATION_REVIEW: 'pro.application.review',
  PRO_MODERATE: 'pro.moderate',
  PRO_AVAILABILITY_SET: 'pro.availability.set',
  CATALOG_MANAGE: 'catalog.manage',
  /**
   * Deliberately separate from CATALOG_MANAGE: repricing a service and
   * changing what a Pro earns from it are different decisions with different
   * owners (US-3.10, US-8.4). An ops admin editing a price should not be able
   * to move the commission rate as a side effect.
   */
  CATALOG_COMMISSION_SET: 'catalog.commission.set',
  CATALOG_CITY_MANAGE: 'catalog.city.manage',
  BOOKING_READ: 'booking.read',
  BOOKING_CANCEL: 'booking.cancel',
  /**
   * Starting a job without the customer's OTP. Its own code because the OTP is
   * the trust anchor: it is the only evidence a dispute has that work began
   * with consent, and bypassing it should be a deliberate grant, not something
   * that rides along with general booking access.
   */
  BOOKING_FORCE_START: 'booking.force_start',
  /** Manual assignment from the live dispatch screen. */
  DISPATCH_OVERRIDE: 'dispatch.override',
} as const;

export type PermissionCode =
  (typeof PermissionCode)[keyof typeof PermissionCode];

export const ALL_PERMISSION_CODES: PermissionCode[] =
  Object.values(PermissionCode);

export const SYSTEM_ROLE_NAMES = [
  'ops',
  'support',
  'finance',
  'super_admin',
] as const;
