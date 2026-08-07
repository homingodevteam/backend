/**
 * Prisma stores all of these as plain `String` columns (matching the
 * original `character varying` shape rather than native Postgres enums),
 * so the generated Prisma types are just `string`. These aliases are the
 * TS-side source of truth for which literal values are actually valid.
 */
export type ProStatus =
  'applied' | 'under_review' | 'approved' | 'suspended' | 'rejected';

export type QueueStatus =
  'pending' | 'docs_review' | 'call_pending' | 'approved' | 'rejected';

export type DocumentSource = 'manual' | 'digilocker';
export type DocumentStatus = 'pending' | 'verified' | 'rejected';
export type ReferredByType = 'pro' | 'customer' | 'none';
export type ApplicationDecision = 'approved' | 'rejected';
export type Proficiency = 'trainee' | 'skilled' | 'expert';
