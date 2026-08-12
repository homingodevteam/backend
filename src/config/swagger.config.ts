import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Mounts interactive API docs. Returns the path it mounted on, or null when
 * disabled.
 *
 * Docs are on by default outside production and off inside it: an unguarded
 * schema tells an attacker every route, field and validation rule you have.
 * Set SWAGGER_ENABLED=true to override in either direction.
 */
export function setupSwagger(
  app: INestApplication,
  config: ConfigService,
): string | null {
  const nodeEnv = config.get<string>('NODE_ENV', 'local');
  const raw = config.get<string>('SWAGGER_ENABLED');
  const enabled =
    raw === undefined || raw.trim() === ''
      ? nodeEnv !== 'production'
      : ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());

  if (!enabled) return null;

  const path = config.get<string>('SWAGGER_PATH', 'docs');

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(config.get<string>('APP_NAME', 'Homingo API'))
      .setDescription(
        'Homingo backend API. Every endpoint returns the same envelope: ' +
          '`{ success, statusCode, message, data, errors?, timestamp, path? }`.',
      )
      .setVersion(config.get<string>('API_VERSION', 'v1'))
      // Registered ready for JWT auth: the Authorize button sends
      // `Authorization: Bearer <token>` on every try-it-out request.
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Paste the access token (without the "Bearer " prefix)',
        },
        'access-token',
      )
      .build(),
  );

  SwaggerModule.setup(path, app, document, {
    /**
     * `/docs/json`, not Nest's default `/docs-json`.
     *
     * API_CONVENTIONS §2 publishes `/docs/json` as the URL a client generator
     * points at, and it is binding on every module — so the contract is the
     * fixed point and the default is what moves. Before this, the documented
     * URL 404'd and only the undocumented one worked, which is the worst way
     * round: the people following the convention were the ones it failed.
     */
    jsonDocumentUrl: `${path}/json`,
    yamlDocumentUrl: `${path}/yaml`,
    swaggerOptions: {
      // Keep the token across page reloads so you are not re-pasting it.
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: `${config.get<string>('APP_NAME', 'Homingo')} API docs`,
  });

  Logger.log(
    `Swagger docs mounted at /${path} — spec at /${path}/json and /${path}/yaml`,
    'Swagger',
  );
  return path;
}
