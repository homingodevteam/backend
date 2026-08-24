import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import {
  AcknowledgeSosAlertDto,
  ResolveSosAlertDto,
  SosAlertDto,
} from './dto/sos.dto';
import { SosService } from './sos.service';

/**
 * The safety desk.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE QUEUE, UNTIL THERE IS A PAGER
 * ---------------------------------------------------------------------------
 * The story says ops is alerted immediately, bypassing normal queues. There is
 * no push transport in this backend yet, so what "immediately" currently rests
 * on is a console polling `GET /admin/sos/alerts` at a short interval and an
 * error-level log line on every raise. That is honest rather than ideal, and
 * the note on `SosService.raise` marks where a real transport plugs in.
 *
 * The ordering is the part that is not provisional: active alerts first, and
 * within them the **oldest** press at the top. Every other list in this
 * console is newest-first, which here would bury the person who has been
 * waiting longest — the one nobody has reached.
 */
@ApiTags('Admin — Safety')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/sos')
export class AdminSosController {
  constructor(private readonly sos: SosService) {}

  @Get('alerts')
  @RequirePermissions(PermissionCode.SOS_READ)
  @ApiOperation({
    summary: 'The live queue',
    description:
      'Active alerts first, oldest press at the top. Pass `?status=active` ' +
      'for the working queue, or omit it to see everything recent.\n\n' +
      'Poll this. An alarm sitting in a table nobody is watching is not an ' +
      'alarm.',
  })
  @ApiOkEnvelope(SosAlertDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<SosAlertDto[]> {
    return this.sos.listForOps({
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('alerts/:id')
  @RequirePermissions(PermissionCode.SOS_READ)
  @ApiOperation({
    summary: 'One alert, with its context snapshot',
    description:
      'The address, service and Pro name are as they were **when the alarm ' +
      'was raised** — copied, not joined. A booking that has since been ' +
      'reassigned does not get to rewrite the evidence.',
  })
  @ApiOkEnvelope(SosAlertDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  get(@Param('id') id: string): Promise<SosAlertDto> {
    return this.sos.getForOps(id);
  }

  @Post('alerts/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PermissionCode.SOS_RESPOND)
  @ApiOperation({
    summary: 'I have this',
    description:
      'Stamps the alert and flips the customer\'s screen from "sent" to ' +
      '"a person has this". Stamped once — a second responder opening the ' +
      'same alert does not reset how long it took somebody to pick it up.',
  })
  @ApiOkEnvelope(SosAlertDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  acknowledge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AcknowledgeSosAlertDto,
  ): Promise<SosAlertDto> {
    return this.sos.acknowledge(user.id, id, dto);
  }

  @Post('alerts/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PermissionCode.SOS_RESPOND)
  @ApiOperation({
    summary: 'Close it out',
    description:
      '`resolutionNotes` is required. An incident closed with no account of ' +
      'what happened cannot be reviewed later, and a cluster of them in one ' +
      'area is a supply problem nobody will ever spot.\n\n' +
      'Closing as `false_alarm` from here carries exactly the same weight as ' +
      'the customer standing it down themselves: none.',
  })
  @ApiOkEnvelope(SosAlertDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResolveSosAlertDto,
  ): Promise<SosAlertDto> {
    return this.sos.resolve(user.id, id, dto);
  }
}
