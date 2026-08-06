import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDatabaseOptions } from '../config/database.config';

const nodeEnv = process.env.NODE_ENV ?? 'local';
loadEnv({ path: `.env.${nodeEnv}` });
loadEnv({ path: '.env' });

/**
 * Standalone RDS connectivity check: `npm run db:check`.
 * Connects, runs a trivial query, and maps the common AWS failure modes to
 * the thing you actually need to fix — most "cannot connect to RDS" reports
 * are a security group rule, not application code.
 */
async function main(): Promise<void> {
  let options: ReturnType<typeof buildDatabaseOptions>;
  try {
    options = buildDatabaseOptions();
  } catch (error: unknown) {
    // Config is incomplete — report the missing fields plainly rather than
    // dumping a stack trace at someone who just needs to fill in a .env.
    console.error('NOT CONFIGURED\n');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const usingUrl = 'url' in options && Boolean(options.url);

  console.log(`env        : ${nodeEnv}`);
  console.log(
    `source     : ${usingUrl ? 'DATABASE_URL' : 'discrete DB_* fields'}`,
  );
  if (!usingUrl && 'host' in options) {
    console.log(`host       : ${options.host}:${String(options.port)}`);
    console.log(`database   : ${options.database}`);
    console.log(`username   : ${options.username}`);
  }
  console.log(`ssl        : ${JSON.stringify(options.ssl)}`);
  console.log('---');

  const dataSource = new DataSource({ ...options, logging: false });
  const startedAt = process.hrtime.bigint();

  try {
    await dataSource.initialize();
    const [{ version }] =
      await dataSource.query<{ version: string }[]>('SELECT version()');
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(`CONNECTED in ${ms.toFixed(0)}ms`);
    console.log(version);
  } catch (error: unknown) {
    console.error('CONNECTION FAILED\n');
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\n' + diagnose(error));
    process.exitCode = 1;
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

/** Map the raw driver error to the AWS-side cause worth checking first. */
function diagnose(error: unknown): string {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  const code = (error as { code?: string } | null)?.code ?? '';

  if (code === 'ETIMEDOUT' || message.includes('timeout')) {
    return [
      'Likely cause: the RDS security group is not allowing your IP.',
      '  - RDS console > your instance > Connectivity & security > VPC security groups',
      '  - Add an inbound rule: PostgreSQL, TCP 5432, source = your public IP',
      '  - Also confirm "Publicly accessible" is Yes if connecting from outside the VPC',
    ].join('\n');
  }
  if (code === 'ENOTFOUND' || message.includes('getaddrinfo')) {
    return 'Likely cause: DB_HOST is wrong. Use the full RDS endpoint, e.g. mydb.abc123.ap-south-1.rds.amazonaws.com (no port, no https://).';
  }
  if (message.includes('password authentication failed')) {
    return 'Likely cause: DB_USERNAME / DB_PASSWORD mismatch. If the password contains @ : / ? # in DATABASE_URL, it must be percent-encoded.';
  }
  if (message.includes('does not exist')) {
    return 'Likely cause: DB_DATABASE does not exist on the instance. The default RDS database is often "postgres".';
  }
  if (message.includes('self-signed') || message.includes('certificate')) {
    return 'Likely cause: TLS verification. Set DB_SSL_CA to the RDS CA bundle, or DB_SSL_REJECT_UNAUTHORIZED=false to encrypt without verifying.';
  }
  if (message.includes('no pg_hba.conf entry') || message.includes('ssl')) {
    return 'Likely cause: RDS requires TLS but SSL is off. Set DB_SSL=true.';
  }
  return 'Check DB_HOST, the security group inbound rule, and that the instance status is "Available".';
}

void main();
