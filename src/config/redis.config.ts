import type { RedisOptions } from 'ioredis';

type Env = Record<string, string | undefined>;

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Single source of truth for the Redis connection, mirroring
 * database.config.ts: REDIS_URL wins when present, otherwise the discrete
 * REDIS_* fields are assembled into a connection.
 */
export function buildRedisOptions(
  env: Env = process.env,
): { url: string } | RedisOptions {
  const url = str(env.REDIS_URL);
  if (url) return { url };

  const host = str(env.REDIS_HOST);
  if (!host) {
    throw new Error(
      'Redis is not configured. Set REDIS_URL, or REDIS_HOST at minimum, ' +
        `in .env.${env.NODE_ENV ?? 'local'}.`,
    );
  }

  return {
    host,
    port: Number.parseInt(env.REDIS_PORT ?? '6379', 10),
    password: str(env.REDIS_PASSWORD),
    db: Number.parseInt(env.REDIS_DB ?? '0', 10),
    // ioredis default is 20 retries then give up; keep retrying but back off,
    // so a Redis restart doesn't permanently wedge the app.
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  };
}
