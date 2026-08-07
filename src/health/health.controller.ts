import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  /**
   * Liveness + readiness in one. The database ping is the part that matters:
   * a process can be up while RDS is unreachable, and returning 200 in that
   * state tells a load balancer to keep sending traffic it cannot serve.
   * Terminus responds 503 when any indicator fails.
   */
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Service health, including database connectivity' })
  @ApiResponse({ status: 200, description: 'All checks passed' })
  @ApiResponse({ status: 503, description: 'One or more checks failed' })
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      // 3s: long enough to ride out a blip, short enough that a probe
      // does not hang past a typical load balancer timeout.
      () => this.db.pingCheck('database', { timeout: 3000 }),
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
    ]);
  }
}
