import { Controller, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { DispatchService } from './dispatch.service';

/**
 * The Pro's entire surface on an assignment: one button.
 *
 * There is **no accept and no decline**, here or anywhere. A Pro is a salaried
 * employee who cannot refuse work; acknowledging confirms receipt, not
 * agreement. Missing the window costs that job and nothing else — the
 * acceptance rate it moves is reporting only and never touches ranking.
 */
@ApiTags('Pro — Dispatch')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('pro')
@Controller('pros/me/bookings')
export class ProDispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  @Post(':id/acknowledge')
  @ApiOperation({
    summary: 'Acknowledge an assignment',
    description:
      'Confirms you have seen the job. **Not** acceptance — there is nothing ' +
      'to accept and no way to decline. Idempotent: acknowledging twice is ' +
      'not an error.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  acknowledge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.dispatch.acknowledge(user.id, id);
  }
}
