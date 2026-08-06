import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDatabaseOptions } from '../config/database.config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Read through ConfigService so the values come from the same
        // NODE_ENV-selected .env file the rest of the app uses.
        ...buildDatabaseOptions({
          NODE_ENV: config.get<string>('NODE_ENV'),
          DATABASE_URL: config.get<string>('DATABASE_URL'),
          DB_HOST: config.get<string>('DB_HOST'),
          DB_PORT: config.get<string>('DB_PORT'),
          DB_USERNAME: config.get<string>('DB_USERNAME'),
          DB_PASSWORD: config.get<string>('DB_PASSWORD'),
          DB_DATABASE: config.get<string>('DB_DATABASE'),
          DB_SSL: config.get<string>('DB_SSL'),
          DB_SSL_CA: config.get<string>('DB_SSL_CA'),
          DB_SSL_REJECT_UNAUTHORIZED: config.get<string>(
            'DB_SSL_REJECT_UNAUTHORIZED',
          ),
          DB_SYNCHRONIZE: config.get<string>('DB_SYNCHRONIZE'),
          DB_LOGGING: config.get<string>('DB_LOGGING'),
        }),
        // Entities register themselves via forFeature — no glob needed at
        // runtime, which keeps this working under both ts-node and dist.
        autoLoadEntities: true,
        // An RDS instance waking from a reboot or failover can refuse
        // connections briefly; retry instead of crashing the pod.
        retryAttempts: 5,
        retryDelay: 3000,
      }),
    }),
  ],
})
export class DatabaseModule {}
