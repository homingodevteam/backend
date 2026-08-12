import {
  Controller,
  Get,
  HttpStatus,
  Param,
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
import { apiError } from '../../common/utils';
import { AllowSuspendedProRead } from '../identity/decorators/allow-suspended-pro-read.decorator';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CommissionService } from './commission.service';
import {
  CommissionLineDto,
  DeductionStatementDto,
  EarningsQueryDto,
  EarningsSummaryDto,
  PagedQueryDto,
  PayoutDto,
} from './dto/earnings.dto';
import { ProIncentiveDto } from './dto/incentive.dto';
import { IncentivesService } from './incentives.service';
import { ProEarningsService } from './pro-earnings.service';

/**
 * The Pro app's money screens.
 *
 * **Every route here is `@AllowSuspendedProRead()`**, which is unusual enough
 * to state plainly. US-8.12 is explicit that money already earned is still
 * owed, and a suspended Pro who cannot see what they are owed has no way to
 * chase it. Suspension stops someone working; it is not a payment decision, and
 * nothing on this controller lets them act — only read.
 */
@ApiTags('Pro — Earnings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('pro')
@Controller('pros/me')
export class ProEarningsController {
  constructor(
    private readonly earnings: ProEarningsService,
    private readonly incentives: IncentivesService,
    private readonly commissions: CommissionService,
  ) {}

  @Get('earnings/summary')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'My earnings today, this period and lifetime',
    description:
      'Live: these are direct reads of rows the completion hook writes ' +
      'synchronously, so the number moves the moment a job is finished — no ' +
      'end-of-day roll-up to wait for.\n\n' +
      '**Commission and incentives only.** Salary is paid by external payroll ' +
      'and is not in any figure here. `salaryNote` carries the sentence to ' +
      'show; a screen that omits it turns a partial number into a wrong one.',
  })
  @ApiOkEnvelope(EarningsSummaryDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.earnings.summary(user.id);
  }

  @Get('earnings/commissions')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'Job-by-job earnings',
    description:
      'The statement behind the summary. Each line carries the rate that was ' +
      'snapshotted when the job completed, so the arithmetic can be checked.',
  })
  @ApiOkEnvelope(CommissionLineDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EarningsQueryDto,
  ) {
    return this.earnings.commissions(user.id, query);
  }

  @Get('earnings/commissions/:id')
  @AllowSuspendedProRead()
  @ApiOperation({ summary: 'What one job paid, and why' })
  @ApiOkEnvelope(CommissionLineDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async one(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const row = await this.commissions.getForPro(user.id, id);
    return this.earnings.toLine(row);
  }

  @Get('incentives')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'Bonus schemes open to me, and how far along I am',
    description:
      'Only schemes the platform can actually credit are listed. A `streak` or ' +
      '`surge_slot` scheme has no evaluator yet, so showing it would advertise ' +
      'a bonus nothing is counting.',
  })
  @ApiOkEnvelope(ProIncentiveDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  myIncentives(@CurrentUser() user: AuthenticatedUser) {
    return this.incentives.forPro(user.id, new Date());
  }

  @Get('deductions')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'What is being held back, and why',
    description:
      'Money is **never** debited from a Pro’s bank account. When something has ' +
      'to be recovered it appears here and comes off a future payout, itemised. ' +
      'A deduction the Pro can read and argue with is recoverable; a surprise ' +
      'debit is a dispute (US-8.14).',
  })
  @ApiOkEnvelope(DeductionStatementDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  deductions(@CurrentUser() user: AuthenticatedUser) {
    return this.earnings.deductionStatement(user.id);
  }

  @Get('payouts')
  @AllowSuspendedProRead()
  @ApiOperation({ summary: 'My payout history' })
  @ApiOkEnvelope(PayoutDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  payouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PagedQueryDto,
  ) {
    return this.earnings.payouts(user.id, query);
  }

  @Get('payouts/:id')
  @AllowSuspendedProRead()
  @ApiOperation({ summary: 'One payout' })
  @ApiOkEnvelope(PayoutDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async payout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const payout = await this.earnings.payout(user.id, id);
    if (!payout) throw apiError('Payout not found', HttpStatus.NOT_FOUND);
    return payout;
  }

  @Get('payouts/:id/commissions')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'What this payout covered',
    description:
      'Every job inside the batch plus every deduction taken out of it, so the ' +
      'total on the bank statement can be reconciled line by line (US-8.12).',
  })
  @ApiOkEnvelope(CommissionLineDto, { isArray: true })
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async payoutLines(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const detail = await this.earnings.payoutCommissions(user.id, id);
    if (!detail) throw apiError('Payout not found', HttpStatus.NOT_FOUND);
    return detail;
  }
}
