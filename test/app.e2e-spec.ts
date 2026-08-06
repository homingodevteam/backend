import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppController } from './../src/app.controller';
import { AppService } from './../src/app.service';

/**
 * Exercises the real HTTP stack (Fastify routing -> controller) without
 * booting AppModule, which now pulls in DatabaseModule and would require a
 * live AWS RDS instance just to assert on a static route.
 *
 * Once entities exist, add a separate suite that imports AppModule against a
 * throwaway test database (a `.env.test` pointing at a local or containerised
 * Postgres) so the persistence layer is covered too.
 */
describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
  });

  it('/ (GET)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe('Hello World!');
  });

  afterEach(async () => {
    // Guard: if beforeEach threw, `app` is undefined and an unguarded
    // close() masks the real failure with a TypeError.
    if (app) await app.close();
  });
});
