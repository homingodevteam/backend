import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  HealthIndicatorService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../common/swagger/api-envelope.decorator';
import { PrismaService } from '../prisma/prisma.service';

const DB_PING_TIMEOUT_MS = 3000;

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly memory: MemoryHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Liveness + readiness in one. The database ping is the part that matters:
   * a process can be up while RDS is unreachable, and returning 200 in that
   * state tells a load balancer to keep sending traffic it cannot serve.
   * Terminus responds 503 when any indicator fails.
   */
  // Decorator order matters here — see API_CONVENTIONS.md's "the trap".
  // @HealthCheck() must sit BELOW the Swagger envelope decorators:
  // decorators apply bottom-up, and Terminus's own response-schema
  // decoration would silently overwrite ours if it ran last.
  @Get()
  @ApiOperation({ summary: 'Service health, including database connectivity' })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.SERVICE_UNAVAILABLE)
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.pingDatabase(),
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
    ]);
  }

  private async pingDatabase(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check('database');

    // 3s: long enough to ride out a blip, short enough that a probe does not
    // hang past a typical load balancer timeout.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), DB_PING_TIMEOUT_MS),
    );

    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
      return indicator.up();
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : 'unreachable',
      });
    }
  }
}
