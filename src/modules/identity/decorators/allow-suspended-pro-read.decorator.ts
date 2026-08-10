import { SetMetadata } from '@nestjs/common';

export const ALLOW_SUSPENDED_PRO_READ_KEY = 'allowSuspendedProRead';

/**
 * Marks a read-only standing or history endpoint as available to a suspended
 * Pro. Never use this on job actions, profile mutation, or bank-edit routes.
 */
export const AllowSuspendedProRead = () =>
  SetMetadata(ALLOW_SUSPENDED_PRO_READ_KEY, true);
