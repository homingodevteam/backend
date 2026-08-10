import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminCatalogController } from './../src/modules/catalog/admin-catalog.controller';
import { AdminCatalogService } from './../src/modules/catalog/admin-catalog.service';
import { CatalogController } from './../src/modules/catalog/catalog.controller';
import { CatalogService } from './../src/modules/catalog/catalog.service';
import { ServiceCatalogController } from './../src/modules/catalog/service-catalog.controller';
import { ServiceCatalogService } from './../src/modules/catalog/service-catalog.service';
import { JwtAuthGuard } from './../src/modules/identity/guards/jwt-auth.guard';
import { PermissionsGuard } from './../src/modules/identity/guards/permissions.guard';

type Operation = {
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
  security?: unknown[];
};

/**
 * Module 3's half of the API_CONVENTIONS.md contract.
 *
 * `swagger-envelope.e2e-spec.ts` proves the envelope decorators produce the
 * right shape in general. This proves the Service Catalog actually *uses*
 * them — on every route, including the error statuses — so the published spec
 * a frontend generates a client from matches what the API sends. A route
 * added later without the decorators fails here rather than at integration.
 */
describe('Catalog Swagger contract (e2e)', () => {
  let app: NestFastifyApplication;
  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    const allow = { canActivate: () => true };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [
        CatalogController,
        ServiceCatalogController,
        AdminCatalogController,
      ],
      providers: [
        { provide: CatalogService, useValue: {} },
        { provide: ServiceCatalogService, useValue: {} },
        { provide: AdminCatalogService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(PermissionsGuard)
      .useValue(allow)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('catalog test')
        .setVersion('1')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'access-token',
        )
        .build(),
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function operationAt(path: string, method: string): Operation {
    const operation = (
      document.paths[path] as Record<string, Operation> | undefined
    )?.[method];
    if (!operation) {
      throw new Error(
        `No documented operation for ${method.toUpperCase()} ${path}`,
      );
    }
    return operation;
  }

  function envelopePropertiesOf(
    path: string,
    method: string,
    status: number,
  ): string[] {
    const schema = operationAt(path, method).responses?.[String(status)]
      ?.content?.['application/json']?.schema as
      { properties?: Record<string, unknown> } | undefined;
    if (!schema) {
      throw new Error(
        `No response schema for ${method.toUpperCase()} ${path} -> ${status}`,
      );
    }
    return Object.keys(schema.properties ?? {});
  }

  const PUBLIC_ROUTES: Array<[string, string, number]> = [
    ['/cities', 'get', 200],
    ['/catalog/categories', 'get', 200],
    ['/catalog/categories/{id}/services', 'get', 200],
    ['/catalog/services', 'get', 200],
    ['/catalog/services/{id}', 'get', 200],
  ];

  const ADMIN_ROUTES: Array<[string, string, number]> = [
    ['/admin/catalog/categories', 'get', 200],
    ['/admin/catalog/categories', 'post', 201],
    ['/admin/catalog/categories/{id}', 'patch', 200],
    ['/admin/catalog/categories/{id}/activation', 'patch', 200],
    ['/admin/catalog/categories/{id}', 'delete', 200],
    ['/admin/catalog/services', 'get', 200],
    ['/admin/catalog/services', 'post', 201],
    ['/admin/catalog/services/{id}', 'patch', 200],
    ['/admin/catalog/services/{id}/commission', 'patch', 200],
    ['/admin/catalog/services/{id}/activation', 'patch', 200],
    ['/admin/catalog/cities', 'get', 200],
    ['/admin/catalog/cities', 'post', 201],
    ['/admin/catalog/cities/{id}', 'patch', 200],
    ['/admin/catalog/cities/{id}/activation', 'patch', 200],
  ];

  it.each([...PUBLIC_ROUTES, ...ADMIN_ROUTES])(
    'documents %s %s as the envelope, not the bare payload',
    (path, method, status) => {
      const properties = envelopePropertiesOf(path, method, status);

      expect(properties).toEqual(
        expect.arrayContaining([
          'success',
          'statusCode',
          'message',
          'data',
          'timestamp',
        ]),
      );
      // A bare @ApiOkResponse({ type: Dto }) would hoist the payload's own
      // fields to the top level. They belong under `data` and nowhere else.
      expect(properties).not.toEqual(
        expect.arrayContaining(['id', 'name', 'flatPrice']),
      );
    },
  );

  it.each(ADMIN_ROUTES)(
    'declares bearer auth and a 403 on %s %s',
    (path, method) => {
      const operation = operationAt(path, method);

      expect(operation.security).toEqual(
        expect.arrayContaining([{ 'access-token': [] }]),
      );
      // Every admin route sits behind PermissionsGuard, so 403 is a real
      // outcome a client has to handle — it must be documented.
      expect(operation.responses).toHaveProperty('403');
    },
  );

  it('does not put bearer auth on the public browse routes', () => {
    for (const [path, method] of PUBLIC_ROUTES) {
      expect(operationAt(path, method).security ?? []).toEqual([]);
    }
  });

  it('documents list endpoints as data: array', () => {
    const schema = operationAt('/catalog/services', 'get').responses?.['200']
      ?.content?.['application/json']?.schema as
      { properties?: { data?: { type?: string } } } | undefined;

    expect(schema?.properties?.data?.type).toBe('array');
  });

  it('publishes flatPrice as a string, not a number', () => {
    // CONFLICTS_AND_DECISIONS #12: Prisma serialises Decimal as a string, and
    // a client that parseFloat()s a money total will drift. The schema has to
    // say so.
    const schemas = document.components?.schemas as
      | Record<string, { properties?: Record<string, { type?: string }> }>
      | undefined;

    expect(schemas?.ServiceDto?.properties?.flatPrice?.type).toBe('string');
    expect(schemas?.AdminServiceDto?.properties?.commissionValue?.type).toBe(
      'string',
    );
  });

  it('keeps commission off the customer-facing service schema — US-3.2', () => {
    const schemas = document.components?.schemas as
      Record<string, { properties?: Record<string, unknown> }> | undefined;
    const customerFacing = Object.keys(schemas?.ServiceDto?.properties ?? {});

    expect(customerFacing).not.toEqual(
      expect.arrayContaining(['commissionType', 'commissionValue']),
    );
  });
});
