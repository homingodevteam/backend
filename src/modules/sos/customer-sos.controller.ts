import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import {
  CreateSosAlertDto,
  SosAlertDto,
  StandDownSosAlertDto,
} from './dto/sos.dto';
import { SosService } from './sos.service';

/**
 * The alarm, from the customer app.
 *
 * ---------------------------------------------------------------------------
 * WHY POST RETURNS 200 AND NOT 201
 * ---------------------------------------------------------------------------
 * The app retries queued alarms, and a retry returns the row the first attempt
 * created. Reporting 201 for one and 200 for the other would invite a client
 * to branch on the difference — and the only correct behaviour on either is
 * "the alarm is in, stop retrying". So both answer 200 and the client has
 * nothing to get wrong.
 */
@ApiTags('Safety')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('customer')
@Controller('sos')
export class CustomerSosController {
  constructor(private readonly sos: SosService) {}

  @Post('alerts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Raise an alarm',
    description:
      'Writes the alert and puts it at the top of the ops queue.\n\n' +
      '**Almost every field is optional on purpose.** No GPS fix indoors, no ' +
      'booking when the Safety screen was opened from the account tab, no ' +
      'address on a thin profile — an alarm still lands with whatever the ' +
      'device could gather. The only thing that stops a row being written is ' +
      'the database being unreachable.\n\n' +
      'Send `clientAlertId` and retry freely: the same key returns the same ' +
      'alert instead of raising a second incident.',
  })
  @ApiOkEnvelope(SosAlertDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.BAD_REQUEST)
  raise(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSosAlertDto,
  ): Promise<SosAlertDto> {
    return this.sos.raise(user.id, dto);
  }

  @Post('alerts/:id/stand-down')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'I am safe',
    description:
      'Ends the alert. Takes no reason and asks no question.\n\n' +
      '**A false alarm carries no consequence of any kind** — nothing counts ' +
      'them, rate-limits on them or shows them back on the account. ' +
      'Hesitating to press the button because of what happens if you are ' +
      'wrong is the failure this feature exists to prevent (US-11.4).\n\n' +
      'Idempotent: standing down twice returns the same alert.',
  })
  @ApiOkEnvelope(SosAlertDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  standDown(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: StandDownSosAlertDto,
  ): Promise<SosAlertDto> {
    return this.sos.standDown(user.id, id, dto);
  }

  @Get('alerts/active')
  @ApiOperation({
    summary: 'The alarm still running, if any',
    description:
      'What the app reopens onto after a restart, so a live incident does ' +
      'not disappear because the process was killed.',
  })
  @ApiOkEnvelope(SosAlertDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  active(@CurrentUser() user: AuthenticatedUser): Promise<SosAlertDto | null> {
    return this.sos.findActive(user.id);
  }

  @Get('alerts')
  @ApiOperation({
    summary: 'My alarms',
    description:
      'Newest first. Lets a device that queued an alarm offline and was ' +
      'killed before draining find out whether the press ever landed.',
  })
  @ApiOkEnvelope(SosAlertDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  mine(@CurrentUser() user: AuthenticatedUser): Promise<SosAlertDto[]> {
    return this.sos.listMine(user.id);
  }
}
