import { Controller, Get, HttpStatus } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { ApiProperty, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from './../src/common/swagger/api-envelope.decorator';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './../src/common/interceptors/response.interceptor';
import { apiError } from './../src/common/utils';

class WidgetDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  label: string;
}

@Controller('widgets')
class WidgetsController {
  @Get(':id')
  @ApiOkEnvelope(WidgetDto)
  @ApiErrorEnvelope(HttpStatus.NOT_FOUND)
  findOne(): WidgetDto {
    return { id: 'w1', label: 'Sprocket' };
  }

  @Get()
  @ApiOkEnvelope(WidgetDto, { isArray: true })
  findAll(): WidgetDto[] {
    return [{ id: 'w1', label: 'Sprocket' }];
  }

  @Get('missing/one')
  @ApiOkEnvelope(WidgetDto)
  @ApiErrorEnvelope(HttpStatus.NOT_FOUND)
  missing(): never {
    throw apiError('Widget not found', HttpStatus.NOT_FOUND);
  }
}

/**
 * API_CONVENTIONS.md's rule: Swagger reads a handler's bare return type,
 * and ResponseInterceptor adds the envelope afterward — so the only way the
 * published OpenAPI spec matches what a client actually receives is via
 * @ApiOkEnvelope/@ApiErrorEnvelope. This asserts both sides at once: the
 * generated schema really is the envelope shape, and a live response's real
 * JSON keys match what that schema promises. If someone changes utils.ts's
 * ApiResponse shape without updating api-envelope.decorator.ts (or vice
 * versa), this fails.
 */
describe('Swagger envelope contract (e2e)', () => {
  let app: NestFastifyApplication;
  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [WidgetsController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('test').setVersion('1').build(),
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function envelopeSchemaOf(path: string, method: 'get', status: number) {
    const operation = document.paths[path]?.[method];
    if (!operation)
      throw new Error(
        `No documented operation for ${method.toUpperCase()} ${path}`,
      );
    const response = operation.responses?.[String(status)] as
      { content?: Record<string, { schema?: unknown }> } | undefined;
    const schema = response?.content?.['application/json']?.schema;
    if (!schema)
      throw new Error(
        `No response schema for ${method.toUpperCase()} ${path} -> ${status}`,
      );
    return schema as { properties?: Record<string, unknown> };
  }

  it('documents the 200 response as the envelope, not the bare DTO', () => {
    const schema = envelopeSchemaOf('/widgets/{id}', 'get', 200);
    const properties = Object.keys(schema.properties ?? {});

    // The envelope's own fields must be present...
    expect(properties).toEqual(
      expect.arrayContaining([
        'success',
        'statusCode',
        'message',
        'data',
        'timestamp',
      ]),
    );
    // ...and the DTO's fields must NOT be at the top level — they only
    // belong nested under `data`. A bare @ApiOkResponse({ type: WidgetDto })
    // would fail this by putting `id`/`label` here instead.
    expect(properties).not.toEqual(expect.arrayContaining(['id', 'label']));
  });

  it('documents an array payload as data: array, not data: object', () => {
    const schema = envelopeSchemaOf('/widgets', 'get', 200);
    const dataSchema = schema.properties?.data as { type?: string } | undefined;
    expect(dataSchema?.type).toBe('array');
  });

  it('documents the declared error status with the same envelope shape', () => {
    const schema = envelopeSchemaOf('/widgets/{id}', 'get', 404);
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['success', 'statusCode', 'message', 'data']),
    );
  });

  it('a live 200 response actually has the keys the schema promises', async () => {
    const res = await app.inject({ method: 'GET', url: '/widgets/w1' });
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    const documentedKeys = Object.keys(
      envelopeSchemaOf('/widgets/{id}', 'get', 200).properties ?? {},
    );

    for (const key of documentedKeys) {
      if (key === 'path') continue; // only present when a filter/interceptor has the request path
      expect(body).toHaveProperty(key);
    }
    expect(body.data).toEqual({ id: 'w1', label: 'Sprocket' });
  });

  it('a live error response actually has the keys the schema promises', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/widgets/missing/one',
    });
    const body = JSON.parse(res.payload) as Record<string, unknown>;

    expect(res.statusCode).toBe(404);
    expect(body).toMatchObject({ success: false, statusCode: 404, data: null });
  });
});
