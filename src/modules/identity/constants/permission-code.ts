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
