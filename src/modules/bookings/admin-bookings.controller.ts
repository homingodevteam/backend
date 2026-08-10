import {
  Body,
  Controller,
  Get,
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
import type { Booking } from '../../prisma/client';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { BookingCancellationService } from './booking-cancellation.service';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingsService } from './bookings.service';
import { AdminCancelBookingDto } from './dto/cancel-booking.dto';
import { BookingDto } from './dto/booking.dto';
import { AssignProDto, ForceStartDto } from './dto/lifecycle.dto';
import { RecurringPlansService } from './recurring-plans.service';

@ApiTags('Admin — Bookings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/bookings')
export class AdminBookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly cancellation: BookingCancellationService,
    private readonly plans: RecurringPlansService,
  ) {}

  @Get(':id')
  @RequirePermissions(PermissionCode.BOOKING_READ)
  @ApiOperation({
    summary: 'Reconstruct a job',
    description:
      'The full record in **one** call — status timeline with coordinates, ' +
      'photo proofs, and the chat thread. US-4.24 makes this a design ' +
      'constraint: if reconstruction takes four tabs, disputes get settled on ' +
      'the customer’s word instead of the record.',
  })
  @ApiOkEnvelope(BookingDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  reconstruct(@Param('id') id: string): Promise<Booking> {
    return this.bookings.reconstruct(id);
  }

  @Get(':id/cancellation-window')
  @RequirePermissions(PermissionCode.BOOKING_READ)
  @ApiOperation({
    summary: 'Which cancellation window this booking is in',
    description:
      'A–F, plus whether a fee applies and whether the decision needs a human.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  window(@Param('id') id: string) {
    return this.cancellation.describeWindow(id);
  }

  @Post(':id/assign')
  @RequirePermissions(PermissionCode.DISPATCH_OVERRIDE)
  @ApiOperation({
    summary: 'Assign a Pro by hand',
    description:
      'The manual stand-in while Dispatch (module 5) does not exist, and the ' +
      'ops override that survives once it does.',
  })
  @ApiOkEnvelope(BookingDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  assign(
    @Param('id') id: string,
    @Body() dto: AssignProDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<Booking> {
    return this.bookings.assignPro(id, dto.proId, actor.id, dto.reason);
  }

  @Post(':id/force-start')
  @RequirePermissions(PermissionCode.BOOKING_FORCE_START)
  @ApiOperation({
    summary: 'Start a job without the customer’s code',
    description:
      'The documented override for when the person at the door is not the ' +
      'account holder. Recorded as `start_otp_bypassed` on the timeline so it ' +
      'is visibly **not** an OTP-verified start — a dispute will turn on ' +
      'exactly that distinction.',
  })
  @ApiOkEnvelope(BookingDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  forceStart(
    @Param('id') id: string,
    @Body() dto: ForceStartDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<Booking> {
    return this.lifecycle.forceStart(id, actor.id, dto.reason);
  }

  @Post(':id/cancel')
  @RequirePermissions(PermissionCode.BOOKING_CANCEL)
  @ApiOperation({
    summary: 'Cancel a booking as ops',
    description:
      'Reaches every window including E (job under way), which is the only ' +
      'path allowed to set a discretionary refund. Never charge a fee when the ' +
      'platform is the party that failed.',
  })
  @ApiOkEnvelope(BookingDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  cancel(
    @Param('id') id: string,
    @Body() dto: AdminCancelBookingDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<Booking> {
    return this.cancellation.cancelAsOps(
      actor.id,
      id,
      dto.reason,
      dto.refundAmount,
      dto.cancellationFeeAmount,
    );
  }

  @Post('expire-unpaid')
  @RequirePermissions(PermissionCode.BOOKING_CANCEL)
  @ApiOperation({
    summary: 'Cancel online bookings that were never paid for',
    description:
      'Sweeps `awaiting_payment` past the configured hold window (US-4.6), so ' +
      'abandoned checkouts do not clog the pipeline. Window A — nothing was ' +
      'charged, so nothing is refunded. Driven by a scheduler once module 12 ' +
      'exists; runnable here meanwhile.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  expireUnpaid(@Query('at') at?: string) {
    return this.cancellation.expireUnpaidBookings(
      at ? new Date(at) : undefined,
    );
  }

  @Post('recurring-plans/run')
  @RequirePermissions(PermissionCode.BOOKING_READ)
  @ApiOperation({
    summary: 'Generate any recurring occurrences now due',
    description:
      'Driven by a scheduled job once Notifications (module 12) brings a ' +
      'scheduler; exposed here so it can be run and tested meanwhile.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  runRecurring(@Query('at') at?: string) {
    return this.plans.generateDueBookings(at ? new Date(at) : undefined);
  }
}
