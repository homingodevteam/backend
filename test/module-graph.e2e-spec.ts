import { TestingModule, Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { RedisService } from './../src/redis/redis.service';
import { S3Service } from './../src/storage/s3.service';
import { BookingsService } from './../src/modules/bookings/bookings.service';
import { CatalogService } from './../src/modules/catalog/catalog.service';
import { ProServiceAssignmentsService } from './../src/modules/pros/pro-service-assignments.service';

/**
 * Proves the real module graph resolves.
 *
 * Catalog and Pro Management depend on each other — Pros needs the catalogue
 * to validate a service assignment, Catalog needs Pro supply counts to gate a
 * city launch (US-3.9) — so both sides use `forwardRef`. A mistake there is
 * invisible to unit tests, which construct services by hand, and surfaces only
 * as "Nest can't resolve dependencies" at boot.
 *
 * `compile()` performs full dependency resolution but does not run
 * `onModuleInit`, so this needs no database or Redis — only stubs to construct.
 */
describe('Module graph (e2e)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    // Only the three providers that need real infrastructure to *construct*
    // are stubbed. Everything else is the genuine wiring, which is the point.
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({})
      .overrideProvider(S3Service)
      .useValue({})
      .compile();
  });

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
  });

  it('resolves the whole application without a circular-dependency failure', () => {
    expect(moduleRef).toBeDefined();
  });

  it('injects ProsService into CatalogService across the forwardRef', () => {
    const catalog = moduleRef.get(CatalogService);

    // If the forwardRef were wrong this would be undefined rather than a
    // working collaborator, and the city-activation gate would silently throw
    // at request time instead of at boot.
    expect(catalog).toBeDefined();
    expect((catalog as unknown as { pros?: unknown }).pros).toBeDefined();
  });

  it('registers the real dispatch engine into module 4’s port delegate', () => {
    // Nest resolves providers per module, so DispatchModule cannot simply
    // re-bind DISPATCH_PORT — BookingsService would keep getting the no-op.
    // The delegate is what makes the swap work without module 4 ever
    // importing module 5, and this asserts the wiring actually took.
    const bookings = moduleRef.get(BookingsService);
    const port = (bookings as unknown as { dispatch?: unknown }).dispatch as {
      isEngineRegistered?: boolean;
    };

    expect(port).toBeDefined();
    expect(port.isEngineRegistered).toBe(true);
  });

  it('injects the catalog into the Pro service-assignment path', () => {
    const assignments = moduleRef.get(ProServiceAssignmentsService);

    expect(assignments).toBeDefined();
    expect(
      (assignments as unknown as { catalog?: unknown }).catalog,
    ).toBeDefined();
  });
});
