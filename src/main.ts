import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  const config = app.get(ConfigService);
  // dotenv values are always strings — coerce before Fastify sees it.
  const port = Number(config.get<string>('PORT', '3000'));
  const host = config.get<string>('HOST', '0.0.0.0');
  const apiPrefix = config.get<string>('API_PREFIX', 'api');
  const apiVersion = config.get<string>('API_VERSION', 'v1');

  app.setGlobalPrefix(`${apiPrefix}/${apiVersion}`);
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN', '*') });

  await app.listen(port, host);

  Logger.log(
    `${config.get<string>('APP_NAME', 'app')} running in ` +
      `${config.get<string>('NODE_ENV', 'local')} mode on ` +
      `http://${host}:${port}/${apiPrefix}/${apiVersion}`,
    'Bootstrap',
  );
}
void bootstrap();
