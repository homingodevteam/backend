import { Body, Controller, Get, Post, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { IsEmail, IsInt, Min } from 'class-validator';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './../src/common/interceptors/response.interceptor';
import { apiError, successResponse } from './../src/common/utils';
import { VALIDATION_PIPE_OPTIONS } from './../src/config/validation.config';

/** Shape asserted against; `res.json()` is untyped, so parse deliberately. */
interface Envelope<T = unknown> {
  success: boolean;
  statusCode: number;
  message: string;
  data: T;
  errors?: { message: string }[] | null;
  timestamp: string;
  path?: string;
}

function envelope<T = unknown>(res: { payload: string }): Envelope<T> {
  return JSON.parse(res.payload) as Envelope<T>;
}

class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsInt()
  @Min(18)
  age!: number;
}

@Controller('demo')
class DemoController {
  @Get('plain')
  plain(): { id: number } {
    return { id: 1 };
  }

  @Get('enveloped')
  enveloped() {
    return successResponse({ data: { id: 2 }, message: 'Custom message' });
  }

  @Get('boom')
  boom(): never {
    throw apiError('User not found', 404);
  }

  @Get('crash')
  crash(): never {
    throw new Error('unexpected failure with sensitive detail');
  }

  @Post('users')
  create(@Body() dto: CreateUserDto): CreateUserDto {
    return dto;
  }
}

/**
 * Locks in the contract the whole API depends on: one envelope for every
 * outcome, and validation that actually rejects bad input.
 */
describe('Response envelope + validation (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DemoController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    // Same wiring as main.ts, so this tests the real configuration.
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('wraps a plain return value in the envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/demo/plain' });
    const body = envelope(res);

    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      success: true,
      statusCode: 200,
      message: 'Success',
      data: { id: 1 },
      path: '/demo/plain',
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('does not double-wrap a handler that built its own envelope', async () => {
    const body = envelope<{ id: number; data?: unknown }>(
      await app.inject({ method: 'GET', url: '/demo/enveloped' }),
    );

    expect(body.message).toBe('Custom message');
    expect(body.data).toEqual({ id: 2 });
    // The giveaway for double-wrapping would be data.data existing.
    expect(body.data.data).toBeUndefined();
  });

  it('renders a thrown apiError in the same envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/demo/boom' });

    expect(res.statusCode).toBe(404);
    expect(envelope(res)).toMatchObject({
      success: false,
      statusCode: 404,
      message: 'User not found',
      data: null,
    });
  });

  it('hides internal detail on an unexpected crash', async () => {
    const res = await app.inject({ method: 'GET', url: '/demo/crash' });
    const body = envelope(res);

    expect(res.statusCode).toBe(500);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Internal server error');
    // The raw error text must never reach the client.
    expect(JSON.stringify(body)).not.toContain('sensitive detail');
  });

  it('rejects invalid fields with structured errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/demo/users',
      payload: { email: 'not-an-email', age: 12 },
    });
    const body = envelope(res);

    expect(res.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Validation failed');
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects unknown properties instead of silently dropping them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/demo/users',
      payload: { email: 'a@b.com', age: 30, isAdmin: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('isAdmin');
  });

  it('accepts a valid payload and coerces types', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/demo/users',
      payload: { email: 'a@b.com', age: 30 },
    });
    const body = envelope(res);

    expect(res.statusCode).toBe(201);
    expect(body.success).toBe(true);
    expect(body.statusCode).toBe(201);
    expect(body.data).toEqual({ email: 'a@b.com', age: 30 });
  });
});
