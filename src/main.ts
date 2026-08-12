import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { setupSwagger } from './config/swagger.config';
import { VALIDATION_PIPE_OPTIONS } from './config/validation.config';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      // Razorpay signs each webhook with an HMAC over the EXACT bytes it
      // delivered. Parsing and re-serialising does not round-trip key order,
      // unicode escaping or whitespace, so verifying against the parsed body
      // fails intermittently and unreproducibly — the worst failure mode
      // available to code that decides whether a customer has paid.
      //
      // This is the only reason the option is on, and module 7's webhook
      // handler is its only reader. See CONFLICTS_AND_DECISIONS #38.
      rawBody: true,
    },
  );

  const config = app.get(ConfigService);
  // dotenv values are always strings — coerce before Fastify sees it.
  const port = Number(config.get<string>('PORT', '3000'));
  const host = config.get<string>('HOST', '0.0.0.0');
  const apiPrefix = config.get<string>('API_PREFIX', 'api');
  const apiVersion = config.get<string>('API_VERSION', 'v1');
  const globalPrefix = `${apiPrefix}/${apiVersion}`;

  app.setGlobalPrefix(globalPrefix);
  // @fastify/cors defaults `methods` to 'GET,HEAD,POST' when unset — every
  // PATCH/DELETE mutation (i.e. most admin actions) would fail CORS
  // preflight from a browser otherwise. curl/Postman never hit this since
  // they skip the preflight entirely, which is how it went unnoticed.
  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN', '*'),
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });

  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  // One consistent envelope for both outcomes: the interceptor wraps
  // successes, the filter wraps every failure.
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  // Socket.IO runs alongside Fastify rather than through it: the gateway
  // needs its own protocol upgrade, and without this adapter the gateway is
  // instantiated, logs nothing, and silently never accepts a connection.
  app.useWebSocketAdapter(new IoAdapter(app));

  const swaggerPath = setupSwagger(app, config);

  await app.listen(port, host);

  const base = `http://${host}:${port}`;
  Logger.log(
    `${config.get<string>('APP_NAME', 'app')} running in ` +
      `${config.get<string>('NODE_ENV', 'local')} mode on ${base}/${globalPrefix}`,
    'Bootstrap',
  );
  Logger.log(`Health check at ${base}/${globalPrefix}/health`, 'Bootstrap');
  if (swaggerPath)
    Logger.log(`API docs at ${base}/${swaggerPath}`, 'Bootstrap');
  Logger.log(`Live tracking socket at ${base}/tracking`, 'Bootstrap');
}
void bootstrap();
