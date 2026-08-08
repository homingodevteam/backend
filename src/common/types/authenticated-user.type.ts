/** Actor kinds sharing the one auth mechanism (phone + OTP). */
export type ActorType = 'customer' | 'pro' | 'admin';
export type AccessMode = 'full' | 'suspended_read_only';

/**
 * Shape `JwtAuthGuard` attaches to `request.user` after verifying an access
 * token. `roleId` is only present for `admin` — Customers and Pros have no
 * RBAC role, they're already scoped to their own records.
 */
export interface AuthenticatedUser {
  id: string;
  actorType: ActorType;
  roleId?: string;
  accessMode?: AccessMode;
  /** Reloaded from AdminUser on every request; never trusted from a JWT. */
  cityScope?: string[];
}
