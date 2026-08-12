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
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { successResponse } from '../../common/utils';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { CommissionAdminService } from './commission-admin.service';
import {
  BatchResultDto,
  GeneratePayoutsDto,
  PayoutDto,
  PayoutQueryDto,
  PayoutSummaryDto,
  PayoutSummaryQueryDto,
  RejectPayoutDto,
} from './dto/earnings.dto';
import { PayoutBatchService } from './payout-batch.service';
import { PayoutDisbursementService } from './payout-disbursement.service';

/**
 * The largest outbound money movement in the system, and the only place in
 * this API where two different permissions gate two halves of one action.
 *
 * `payout.approve` says the batch is correct. `payout.disburse` sends it.
 * Neither is granted to `ops`, and ideally they sit with different people —
 * US-8.10 asks for exactly that, and storing both `approvedByAdminId` and
 * `disbursedByAdminId` is what makes it auditable rather than merely intended.
 */
@ApiTags('Admin — Payouts')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/payouts')
export class AdminPayoutsController {
  constructor(
    private readonly batches: PayoutBatchService,
    private readonly disbursement: PayoutDisbursementService,
    private readonly admin: CommissionAdminService,
  ) {}

  @Post('generate')
  @RequirePermissions(PermissionCode.PAYOUT_APPROVE)
  @ApiOperation({
    summary: 'Build draft payouts for a period',
    description:
      'One batch per Pro: approved unpaid commissions, plus the incentives on ' +
      'them, minus whatever they owe.\n\n' +
      '**Read `skipped`.** Everybody on that list worked and is not about to be ' +
      'paid — usually because they have no verified bank account. A shorter ' +
      'batch with nothing said about it reads as success.\n\n' +
      'Safe to re-run: a commission already in a batch is no longer unpaid, so ' +
      'a second run over the same period creates nothing.',
  })
  @ApiCreatedEnvelope(BatchResultDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
  )
  async generate(@Body() dto: GeneratePayoutsDto) {
    const result = await this.batches.generate(dto);
    return successResponse({
      data: result,
      message:
        result.skipped.length > 0
          ? `${result.created} payout(s) drafted; ${result.skipped.length} Pro(s) skipped and unpaid.`
          : `${result.created} payout(s) drafted.`,
      statusCode: HttpStatus.CREATED,
    });
  }

  @Get()
  @RequirePermissions(PermissionCode.PAYOUT_READ)
  @ApiOperation({ summary: 'List payout batches' })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(@Query() query: PayoutQueryDto) {
    return this.admin.payouts(query);
  }

  @Get('summary')
  @RequirePermissions(PermissionCode.PAYOUT_READ)
  @ApiOperation({
    summary: 'Finance dashboard totals',
    description:
      'Counted live from the rows, with no cached aggregate to drift. ' +
      '`failedCount` is the number that needs somebody today.',
  })
  @ApiOkEnvelope(PayoutSummaryDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  summary(@Query() query: PayoutSummaryQueryDto) {
    return this.admin.payoutSummary(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionCode.PAYOUT_READ)
  @ApiOperation({ summary: 'One payout batch' })
  @ApiOkEnvelope(PayoutDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  one(@Param('id') id: string) {
    return this.admin.payoutDetail(id);
  }

  @Get(':id/commissions')
  @RequirePermissions(PermissionCode.PAYOUT_READ)
  @ApiOperation({
    summary: 'The line items behind a batch total',
    description: 'Every job in it, and every deduction taken out of it.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  lines(@Param('id') id: string) {
    return this.admin.payoutCommissions(id);
  }

  @Post(':id/approve')
  @RequirePermissions(PermissionCode.PAYOUT_APPROVE)
  @ApiOperation({
    summary: 'Approve a batch for disbursement',
    description:
      'Records who and when. Approving does **not** send anything — that is ' +
      '`POST /admin/payouts/:id/disburse`, behind a different permission.',
  })
  @ApiOkEnvelope(PayoutDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const payout = await this.batches.approve(id, user.id);
    return successResponse({
      data: payout,
      message: 'Approved. Nothing has been sent yet.',
    });
  }

  @Post(':id/reject')
  @RequirePermissions(PermissionCode.PAYOUT_APPROVE)
  @ApiOperation({
    summary: 'Send a batch back',
    description:
      'Releases everything it was holding: the commissions go back to the pool ' +
      'for the next run, and every deduction it had claimed is given back in ' +
      'full. Rejecting a batch must never quietly forgive a debt or lose a job.',
  })
  @ApiOkEnvelope(PayoutDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectPayoutDto,
  ) {
    const payout = await this.batches.reject(id, dto.reason, user.id);
    return successResponse({
      data: payout,
      message: 'Sent back. Its earnings roll into the next batch.',
    });
  }

  @Post(':id/disburse')
  @RequirePermissions(PermissionCode.PAYOUT_DISBURSE)
  @ApiOperation({
    summary: 'Send an approved batch to the bank',
    description:
      'Moves the batch to `processing` and submits it to RazorpayX with an ' +
      'idempotency key.\n\n' +
      '**Nothing is marked paid here.** `paid` is set only when the webhook ' +
      'confirms the transfer, and the commissions inside are marked paid at that ' +
      'same moment (US-8.11). A `202` means the gateway did not answer and the ' +
      'money may be moving — do not resend; reconcile.\n\n' +
      'Returns `501` when RazorpayX is not configured on this deployment. ' +
      'Everything else in the module still works.',
  })
  @ApiOkEnvelope(PayoutDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.BAD_GATEWAY,
    HttpStatus.NOT_IMPLEMENTED,
  )
  async disburse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const payout = await this.disbursement.disburse(id, user.id);
    return successResponse({
      data: payout,
      message:
        'Submitted. It is marked paid only when the bank confirms the transfer.',
    });
  }

  @Post(':id/retry')
  @RequirePermissions(PermissionCode.PAYOUT_DISBURSE)
  @ApiOperation({
    summary: 'Try a failed batch again',
    description:
      'Only from `failed` — a definite refusal. A `processing` batch is ' +
      'deliberately **not** retryable: nobody knows whether the first attempt ' +
      'moved money, and the answer comes from RazorpayX, not from pressing the ' +
      'button again. Each attempt mints a fresh idempotency key.',
  })
  @ApiOkEnvelope(PayoutDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.BAD_GATEWAY,
    HttpStatus.NOT_IMPLEMENTED,
  )
  async retry(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const payout = await this.disbursement.retry(id, user.id);
    return successResponse({
      data: payout,
      message: 'Resubmitted with a new idempotency key.',
    });
  }
}
