import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../prisma/client';

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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('NOT CONFIGURED\n');
    console.error(
      `DATABASE_URL is not set. Fill it in .env.${nodeEnv} — see .env.example.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`env : ${nodeEnv}`);
  console.log(`host: ${safeHost(databaseUrl)}`);
  console.log('---');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const startedAt = process.hrtime.bigint();

  try {
    await prisma.$connect();
    const [{ version }] = await prisma.$queryRaw<
      { version: string }[]
    >`SELECT version()`;
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(`CONNECTED in ${ms.toFixed(0)}ms`);
    console.log(version);
  } catch (error: unknown) {
    console.error('CONNECTION FAILED\n');
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\n' + diagnose(error));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

/** Host:port only — never log the password embedded in DATABASE_URL. */
function safeHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/** Map the Prisma/driver error to the AWS-side cause worth checking first. */
function diagnose(error: unknown): string {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  const code = (error as { code?: string } | null)?.code ?? '';

  if (
    code === 'P1001' ||
    message.includes('timeout') ||
    message.includes("can't reach database server")
  ) {
    return [
      'Likely cause: the RDS security group is not allowing your IP.',
      '  - RDS console > your instance > Connectivity & security > VPC security groups',
      '  - Add an inbound rule: PostgreSQL, TCP 5432, source = your public IP',
      '  - Also confirm "Publicly accessible" is Yes if connecting from outside the VPC',
    ].join('\n');
  }
  if (message.includes('getaddrinfo') || message.includes('enotfound')) {
    return 'Likely cause: the DATABASE_URL host is wrong. Use the full RDS endpoint, e.g. mydb.abc123.ap-south-1.rds.amazonaws.com (no port, no https://).';
  }
  if (code === 'P1000' || message.includes('authentication failed')) {
    return 'Likely cause: username/password mismatch in DATABASE_URL. If the password contains @ : / ? #, it must be percent-encoded.';
  }
  if (code === 'P1003' || message.includes('does not exist')) {
    return 'Likely cause: the database name in DATABASE_URL does not exist on the instance. The default RDS database is often "postgres".';
  }
  if (
    code === 'P1011' ||
    message.includes('self-signed') ||
    message.includes('certificate') ||
    message.includes('ssl')
  ) {
    return 'Likely cause: TLS. Add ?sslmode=require to DATABASE_URL for RDS.';
  }
  return 'Check DATABASE_URL, the security group inbound rule, and that the instance status is "Available".';
}

void main();
