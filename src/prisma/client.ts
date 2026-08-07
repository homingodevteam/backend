/**
 * Every file in this codebase imports Prisma's generated types/class
 * through here instead of '@prisma/client' directly. Prisma 7 requires an
 * explicit `output` path for the generator (see schema.prisma) rather than
 * writing into node_modules/@prisma/client — routing every import through
 * one file means that path only has to be right in one place.
 */
export * from '../../generated/prisma/client';
