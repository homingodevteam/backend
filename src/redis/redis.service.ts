import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { buildRedisOptions } from '../config/redis.config';

/**
 * Thin wrapper around ioredis. Holds every key this codebase writes to
 * Redis instead of a table: OTP codes, OTP request-rate counters, and
 * refresh-token sessions today; Dispatch/Geo modules will add GEO indexes,
 * assignment locks and free-window caches here later.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const options = buildRedisOptions({
      NODE_ENV: this.config.get<string>('NODE_ENV'),
      REDIS_URL: this.config.get<string>('REDIS_URL'),
      REDIS_HOST: this.config.get<string>('REDIS_HOST'),
      REDIS_PORT: this.config.get<string>('REDIS_PORT'),
      REDIS_PASSWORD: this.config.get<string>('REDIS_PASSWORD'),
      REDIS_DB: this.config.get<string>('REDIS_DB'),
    });

    this.client =
      'url' in options ? new Redis(options.url) : new Redis(options);

    this.client.on('error', (err) =>
      this.logger.error(`Redis connection error: ${err.message}`, err.stack),
    );
    this.client.on('connect', () => this.logger.log('Connected to Redis'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  /** Raw client escape hatch for anything the helpers below don't cover. */
  get raw(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async setIfAbsent(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    return (await this.client.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  /** Keys matching a pattern, via non-blocking SCAN rather than KEYS. */
  async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      found.push(...keys);
    } while (cursor !== '0');
    return found;
  }

  /** Delete every key matching a pattern — used for logout-all. */
  async delByPattern(pattern: string): Promise<number> {
    const keys = await this.scanKeys(pattern);
    return this.del(...keys);
  }

  /** Atomic increment used for sliding-window rate limiting. */
  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, ttlSeconds);
    }
    return count;
  }

  /**
   * Upserts one member's position into a GEO index — e.g. GEOADD
   * pros:live <lng> <lat> <proId>. Used for live Pro location; there is no
   * table for this, only a periodic cold flush to Pro.lastKnownLat/Lng.
   */
  async geoAdd(
    key: string,
    longitude: number,
    latitude: number,
    member: string,
  ): Promise<void> {
    await this.client.geoadd(key, longitude, latitude, member);
  }

  async geoRemove(key: string, member: string): Promise<void> {
    await this.client.zrem(key, member);
  }
}
