import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';

// NODE_ENV picks the override file; `.env` is always the fallback beneath it.
// ConfigModule gives the FIRST file that defines a variable precedence, so the
// environment-specific file wins and `.env` fills in whatever it omits.
const nodeEnv = process.env.NODE_ENV ?? 'local';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [`.env.${nodeEnv}`, '.env'],
    }),
    DatabaseModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
