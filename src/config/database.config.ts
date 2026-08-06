import { join } from 'node:path';
import type { TlsOptions } from 'node:tls';
import type { DataSourceOptions } from 'typeorm';

type Env = Record<string, string | undefined>;

/**
 * The Postgres member of TypeORM's options union. Narrowing here (rather
 * than returning the whole union) keeps driver-specific fields like `ssl`
 * visible to callers.
 */
export type DatabaseOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

/** dotenv hands back strings — treat the usual truthy spellings as true. */
function toBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A key present but blank in a .env file (`DB_HOST=`) arrives as "", which
 * `??` happily accepts. Treat blank as absent so a half-filled file fails
 * loudly instead of silently connecting somewhere unintended.
 */
function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * AWS RDS terminates TLS on every instance, so we default SSL ON in
 * production and OFF for a local Postgres that usually has no certificate.
 *
 * `rejectUnauthorized` is the part people get wrong: RDS presents a cert
 * signed by the Amazon RDS CA, which is NOT in Node's default trust store.
 * Verification therefore fails unless you supply that CA bundle. Setting
 * DB_SSL_REJECT_UNAUTHORIZED=false is the common workaround — it still
 * encrypts traffic, but stops verifying who is on the other end, so it does
 * not protect against man-in-the-middle. The correct fix is DB_SSL_CA.
 * Download: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 */
function resolveSsl(env: Env, isProduction: boolean): boolean | TlsOptions {
  const enabled = toBool(env.DB_SSL, isProduction);
  if (!enabled) return false;

  const ca = env.DB_SSL_CA?.trim();
  if (ca) {
    // Verify against the RDS CA bundle. Newlines survive .env round-trips
    // badly, so accept the literal "\n" form as well.
    return { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  }

  return { rejectUnauthorized: toBool(env.DB_SSL_REJECT_UNAUTHORIZED, false) };
}

/**
 * Single source of truth for connection options, shared by the Nest module
 * and the migration CLI so the app and migrations can never target
 * different databases.
 *
 * DATABASE_URL wins when present (RDS consoles and most hosts hand you one);
 * otherwise the discrete DB_* fields are assembled into a connection.
 */
export function buildDatabaseOptions(env: Env = process.env): DatabaseOptions {
  const isProduction = (env.NODE_ENV ?? 'local') === 'production';

  // Schema changes in production must go through a reviewed migration —
  // synchronize rewrites tables to match entities and will drop columns.
  const synchronize = isProduction ? false : toBool(env.DB_SYNCHRONIZE, false);

  const shared = {
    type: 'postgres' as const,
    entities: [join(__dirname, '..', '**', '*.entity{.ts,.js}')],
    migrations: [join(__dirname, '..', 'database', 'migrations', '*{.ts,.js}')],
    migrationsTableName: 'migrations',
    synchronize,
    logging: toBool(env.DB_LOGGING, !isProduction),
    ssl: resolveSsl(env, isProduction),
  };

  const url = str(env.DATABASE_URL);
  if (url) {
    return { ...shared, url };
  }

  const host = str(env.DB_HOST);
  const username = str(env.DB_USERNAME);
  const database = str(env.DB_DATABASE);

  // Fail with a list of what to fill rather than defaulting to localhost —
  // a blank DB_HOST otherwise connects to whatever Postgres is running
  // locally, which looks like success until the data is in the wrong place.
  const missing = [
    ['DB_HOST', host],
    ['DB_USERNAME', username],
    ['DB_DATABASE', database],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Database is not configured. Missing in .env.${env.NODE_ENV ?? 'local'}: ` +
        `${missing.join(', ')}. ` +
        `Fill the DB_* fields with your AWS RDS details, or set DATABASE_URL instead.`,
    );
  }

  return {
    ...shared,
    host,
    port: toInt(env.DB_PORT, 5432),
    username,
    password: env.DB_PASSWORD ?? '',
    database,
  };
}
