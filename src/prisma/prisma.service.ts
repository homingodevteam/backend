import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './client';

/**
 * Single Prisma client for the whole app, injected everywhere DatabaseModule
 * repositories used to be. Prisma 7 has no built-in query engine binary
 * anymore — every connection goes through an explicit driver adapter, hence
 * PrismaPg here rather than a schema-level `datasource url`.
 *
 * Connecting explicitly in onModuleInit (rather than lazily on first query)
 * means a broken DATABASE_URL fails at boot, the same way the old TypeORM
 * setup did.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get<string>('DATABASE_URL'),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to Postgres via Prisma');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
