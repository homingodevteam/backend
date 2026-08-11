import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminAreasController } from './../src/modules/geo/admin-areas.controller';
import { AreaNamingService } from './../src/modules/geo/area-naming.service';
import { AreasService } from './../src/modules/geo/areas.service';
import { GeoController } from './../src/modules/geo/geo.controller';
import { LocationService } from './../src/modules/geo/location.service';
import { JwtAuthGuard } from './../src/modules/identity/guards/jwt-auth.guard';
import { PermissionsGuard } from './../src/modules/identity/guards/permissions.guard';

type Operation = {
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
  security?: unknown[];
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
};

/**
 * Module 13's half of the API_CONVENTIONS.md contract.
 *
 * `swagger-envelope.e2e-spec.ts` proves the envelope decorators produce the
 * right shape in general. This proves Geo actually *uses* them on every route,
 * and — more importantly for this module — that the published contract states
 * the two things a client could get catastrophically wrong:
 *
 * 1. **No endpoint anywhere accepts an `areaId`.** The client sends a pin and
 *    the server decides. A route that started accepting one would let a
 *    customer book a service in an area it is not offered in.
 * 2. **The unavailability codes are published**, so a frontend can tell "we do
 *    not operate here" from "we operate here but not for that" without
 *    string-matching a human message.
 */
describe('Geo Swagger contract (e2e)', () => {
  let app: NestFastifyApplication;
  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    const allow = { canActivate: () => true };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [GeoController, AdminAreasController],
      providers: [
        { provide: LocationService, useValue: {} },
        { provide: AreasService, useValue: {} },
        { provide: AreaNamingService, useValue: {} },
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
        .setTitle('geo test')
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
    ['/geo/catalog', 'get', 200],
    ['/geo/serviceability', 'get', 200],
    ['/geo/services/{serviceId}/areas', 'get', 200],
  ];

  const ADMIN_ROUTES: Array<[string, string, number]> = [
    ['/admin/areas/generate-grid', 'post', 201],
    ['/admin/areas', 'post', 201],
    ['/admin/areas/bulk', 'post', 201],
    ['/admin/areas', 'get', 200],
    ['/admin/areas/{id}', 'patch', 200],
    ['/admin/areas/service-matrix', 'get', 200],
    ['/admin/areas/{id}/overlaps', 'get', 200],
    ['/admin/areas/{id}/services', 'get', 200],
    ['/admin/areas/{id}/services', 'post', 201],
    ['/admin/areas/{id}/services', 'put', 200],
    ['/admin/areas/{id}/services/copy', 'post', 201],
    ['/admin/areas/by-service/{serviceId}', 'post', 201],
    ['/admin/areas/{id}/pros', 'post', 201],
    ['/admin/areas/{id}/pros', 'get', 200],
    ['/admin/areas/suggest-names', 'post', 201],
    ['/admin/areas/naming-progress', 'get', 200],
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
      expect(properties).not.toEqual(
        expect.arrayContaining(['area', 'services', 'minLat']),
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
      expect(operation.responses).toHaveProperty('403');
    },
  );

  it('leaves the customer-facing routes unauthenticated', () => {
    // A customer must be able to find out whether we serve their address
    // before creating an account.
    for (const [path, method] of PUBLIC_ROUTES) {
      expect(operationAt(path, method).security ?? []).toEqual([]);
    }
  });

  /**
   * The module's security model in one assertion. A client that could name its
   * own area could book a service anywhere it is not offered — so the contract
   * must never advertise an `areaId` input on a customer route.
   */
  it('never accepts an areaId from the client on a public route', () => {
    for (const [path, method] of PUBLIC_ROUTES) {
      const operation = operationAt(path, method);

      const queryNames = (operation.parameters ?? []).map((p) => p.name);
      expect(queryNames).not.toContain('areaId');
      expect(queryNames).not.toContain('area');

      // ...and no request body at all to smuggle one through.
      expect(operation.requestBody).toBeUndefined();
    }
  });

  /**
   * The public "we are available in…" list must not publish the map's internal
   * state. `gridRef` and `nameSource` would tell a customer that "Vijay Nagar"
   * is really cell C3 of a generated grid nobody has reviewed — and the bounds
   * would hand out the whole service map. Conflict #34's rule: the mapper
   * filters, the DTO documents.
   */
  it('does not leak grid internals to the customer-facing area list', () => {
    const schemas = document.components?.schemas as
      Record<string, { properties?: Record<string, unknown> }> | undefined;

    const publicArea = schemas?.PublicAreaDto?.properties ?? {};
    expect(Object.keys(publicArea).sort()).toEqual([
      'cityId',
      'cityName',
      'id',
      'name',
    ]);

    // ...while the admin shape deliberately does carry them.
    const adminArea = schemas?.AreaDto?.properties ?? {};
    expect(adminArea).toHaveProperty('gridRef');
    expect(adminArea).toHaveProperty('nameSource');
    expect(adminArea).toHaveProperty('mapUrl');
  });

  it('requires lat and lng on both pin-driven reads', () => {
    for (const path of ['/geo/catalog', '/geo/serviceability']) {
      const required = (operationAt(path, 'get').parameters ?? [])
        .filter((p) => p.required)
        .map((p) => p.name);

      expect(required).toEqual(expect.arrayContaining(['lat', 'lng']));
    }
  });

  /**
   * A frontend needs to distinguish "we do not operate here" from "we operate
   * here but not for that" — they are different screens. String-matching the
   * human message would break the moment the copy is edited.
   */
  it('publishes both unavailability codes as an enum', () => {
    const schemas = document.components?.schemas as
      | Record<string, { properties?: Record<string, { enum?: string[] }> }>
      | undefined;

    expect(schemas?.ServiceabilityDto?.properties?.code?.enum).toEqual(
      expect.arrayContaining([
        'LOCATION_NOT_SERVICEABLE',
        'SERVICE_NOT_AVAILABLE_IN_AREA',
      ]),
    );
  });

  /**
   * The catalogue returns unavailable services flagged rather than hidden, so
   * the flag and its reason have to be in the published schema or a client
   * will not know to render them differently.
   */
  it('publishes isAvailable and unavailableReason on the location catalogue', () => {
    const schemas = document.components?.schemas as
      Record<string, { properties?: Record<string, unknown> }> | undefined;

    expect(schemas?.LocationServiceDto?.properties).toHaveProperty(
      'isAvailable',
    );
    expect(schemas?.LocationServiceDto?.properties).toHaveProperty(
      'unavailableReason',
    );
  });

  /** CONFLICTS_AND_DECISIONS #12 — money is a string, here as everywhere. */
  it('publishes flatPrice as a string on the location catalogue', () => {
    const schemas = document.components?.schemas as
      | Record<string, { properties?: Record<string, { type?: string }> }>
      | undefined;

    expect(schemas?.LocationServiceDto?.properties?.flatPrice?.type).toBe(
      'string',
    );
  });

  /**
   * Half-open bounds are the model's load-bearing detail and a client drawing
   * these on a map has to know which edges are inclusive. The description is
   * the only place that can say so.
   */
  it('documents the half-open bounds on the area schema', () => {
    const schemas = document.components?.schemas as
      | Record<
          string,
          { properties?: Record<string, { description?: string }> }
        >
      | undefined;

    const bounds = schemas?.AreaDto?.properties;
    expect(bounds?.minLat?.description).toMatch(/inclusive/i);
    expect(bounds?.maxLat?.description).toMatch(/exclusive/i);
    expect(bounds?.minLng?.description).toMatch(/inclusive/i);
    expect(bounds?.maxLng?.description).toMatch(/exclusive/i);
  });
});
