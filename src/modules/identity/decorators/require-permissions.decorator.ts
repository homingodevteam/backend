import { SetMetadata } from '@nestjs/common';
import { PermissionCode } from '../constants/permission-code';

export const PERMISSIONS_KEY = 'requiredPermissions';

/** Declares the permission codes PermissionsGuard checks for a route. */
export const RequirePermissions = (...codes: PermissionCode[]) =>
  SetMetadata(PERMISSIONS_KEY, codes);
