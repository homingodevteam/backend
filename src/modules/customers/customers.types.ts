/**
 * Prisma stores these as plain `String` columns (matching the original
 * `character varying` shape rather than a native Postgres enum), so the
 * generated Prisma types are just `string`. These aliases are the TS-side
 * source of truth for the literal values that are actually valid.
 */
export type AddressLabel = 'home' | 'office' | 'other';
export type CustomerStatus = 'guest' | 'verified';
