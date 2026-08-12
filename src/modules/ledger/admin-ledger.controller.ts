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
import {
  AccountBalanceDto,
  BalancesQueryDto,
  DiscrepancyDto,
  FinanceDashboardDto,
  LedgerEntryDto,
  LedgerQueryDto,
  OpenDiscrepancyQueryDto,
  ReconciliationRunDto,
  ReconciliationRunQueryDto,
  ResolveDiscrepancyDto,
  RunReconciliationDto,
  VerifyQueryDto,
  VerifyResultDto,
} from './dto/ledger.dto';
import { LedgerBalancesService } from './ledger-balances.service';
import { LedgerService } from './ledger.service';
import { ReconciliationRunnerService } from './reconciliation-runner.service';

/**
 * The books, read-only — with one exception, and it is not a write to the
 * ledger.
 *
 * **Nothing in this API appends an entry.** Entries are written by the events
 * that move money, through ports modules 7 and 8 already call. There is no
 * route to create, edit or delete one, and the table refuses `UPDATE` and
 * `DELETE` at the database besides.
 *
 * `ledger.read` is safe and suits finance and ops. `ledger.audit` starts a
 * reconciliation run and closes findings — it changes no money, but it does
 * decide that a question has been answered, which should be attributable.
 */
@ApiTags('Admin — Ledger')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin')
export class AdminLedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly balances: LedgerBalancesService,
    private readonly reconciliation: ReconciliationRunnerService,
  ) {}

  // ------------------------------------------------------------------
  // Ledger
  // ------------------------------------------------------------------

  @Get('ledger')
  @RequirePermissions(PermissionCode.LEDGER_READ)
  @ApiOperation({
    summary: 'Read the ledger',
    description:
      'Newest first. Every entry carries both legs, so `account` matches ' +
      'whichever side you know.',
  })
  @ApiOkEnvelope(LedgerEntryDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(@Query() query: LedgerQueryDto) {
    return this.ledger.list(query);
  }

  @Get('ledger/verify')
  @RequirePermissions(PermissionCode.LEDGER_READ)
  @ApiOperation({
    summary: 'Verify the hash chain',
    description:
      'Recomputes every hash in sequence and checks every link.\n\n' +
      '**`intact: false` is an incident, not a warning.** The table is ' +
      'append-only and refuses `UPDATE`/`DELETE` at the database, so nothing ' +
      'this application does could produce a break — it means a row was changed ' +
      'outside it. `breaks` names the sequence and says whether the row was ' +
      'edited (`hash_mismatch`), re-pointed (`broken_link`) or removed ' +
      '(`sequence_gap`).',
  })
  @ApiOkEnvelope(VerifyResultDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  async verify(@Query() query: VerifyQueryDto) {
    const result = await this.ledger.verify({
      from: query.from === undefined ? undefined : BigInt(query.from),
      limit: query.limit,
    });

    return successResponse({
      data: result,
      message: result.intact
        ? `Chain intact across ${result.entriesChecked} entries.`
        : `CHAIN BROKEN: ${result.breaks.length} break(s), first at sequence ${result.breaks[0].sequence}.`,
    });
  }

  @Get('ledger/balances')
  @RequirePermissions(PermissionCode.LEDGER_READ)
  @ApiOperation({
    summary: 'Account balances',
    description:
      'Signed by each account’s normal side, so a healthy figure reads ' +
      'positive. `payable:pro:<id>` should be zero for a Pro with nothing ' +
      'outstanding — a non-zero one with no unpaid commissions is what the ' +
      'nightly run reports as a discrepancy.',
  })
  @ApiOkEnvelope(AccountBalanceDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  accountBalances(@Query() query: BalancesQueryDto) {
    return this.balances.balances(query.prefix);
  }

  @Get('finance/dashboard')
  @RequirePermissions(PermissionCode.LEDGER_READ)
  @ApiOperation({
    summary: 'What came in today, what is owed out, where the cash is',
    description:
      'Computed live from the entries — no cached total that could disagree ' +
      'with the books.\n\n' +
      'The **variance trend** named in the feature list is deliberately absent: ' +
      'it needs a history of reconciliation runs that does not exist yet, and a ' +
      'trend over two points is a decoration. `GET /admin/reconciliation/runs` ' +
      'is where that history accumulates.',
  })
  @ApiOkEnvelope(FinanceDashboardDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  dashboard() {
    return this.balances.dashboard();
  }

  // ------------------------------------------------------------------
  // Reconciliation
  // ------------------------------------------------------------------

  @Post('reconciliation/run')
  @RequirePermissions(PermissionCode.LEDGER_AUDIT)
  @ApiOperation({
    summary: 'Run reconciliation now',
    description:
      'The same pass that runs nightly at 02:30 IST. Cross-checks the gateway, ' +
      'the cash, the ledger chain and the books against their source tables, ' +
      'and with `scope: all` also rebuilds the derived Pro counters.\n\n' +
      '**Nothing is auto-corrected.** A discrepancy is a question for a human; ' +
      'making our row match the gateway’s would destroy the only evidence that ' +
      'they ever differed.\n\n' +
      'Defaults to the last 24 hours. Walking orders through the gateway has a ' +
      'per-row cost, which is why the window is bounded rather than "everything".',
  })
  @ApiCreatedEnvelope(ReconciliationRunDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
  )
  async run(@Body() dto: RunReconciliationDto) {
    const run = await this.reconciliation.run({
      scope: dto.scope,
      from: dto.from ? new Date(dto.from) : undefined,
      to: dto.to ? new Date(dto.to) : undefined,
      rebuildCounters: dto.rebuildCounters,
    });

    return successResponse({
      data: run,
      statusCode: HttpStatus.CREATED,
      message:
        run.discrepancyCount === 0
          ? 'Reconciled — everything agrees.'
          : `${run.discrepancyCount} discrepancy(ies) found, ${run.totalVarianceAmount.toString()} variance. Nothing has been corrected.`,
    });
  }

  @Get('reconciliation/runs')
  @RequirePermissions(PermissionCode.LEDGER_READ)
  @ApiOperation({ summary: 'Reconciliation history' })
  @ApiOkEnvelope(ReconciliationRunDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  runs(@Query() query: ReconciliationRunQueryDto) {
    return this.reconciliation.runs(query);
  }

  @Get('reconciliation/discrepancies')
  @RequirePermissions(PermissionCode.LEDGER_READ)
  @ApiOperation({
    summary: 'Everything still unresolved',
    description:
      'Across every run, oldest first — the actual work queue. A repeat of the ' +
      'same finding tonight does not bury yesterday’s unanswered one.',
  })
  @ApiOkEnvelope(DiscrepancyDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  open(@Query() query: OpenDiscrepancyQueryDto) {
    return this.reconciliation.openDiscrepancies(query);
  }

  @Get('reconciliation/runs/:id')
  @RequirePermissions(PermissionCode.LEDGER_READ)
  @ApiOperation({
    summary: 'One run and everything it found',
    description: 'Unresolved findings first.',
  })
  @ApiOkEnvelope(ReconciliationRunDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  runDetail(@Param('id') id: string) {
    return this.reconciliation.runDetail(id);
  }

  @Post('reconciliation/discrepancies/:id/resolve')
  @RequirePermissions(PermissionCode.LEDGER_AUDIT)
  @ApiOperation({
    summary: 'Close a finding',
    description:
      'Records who answered it and what they found. Since nothing is ' +
      'auto-corrected, this note is the only record of the answer.\n\n' +
      'Deliberately not a workflow — no states, no assignment, no threads. ' +
      'That is a ticket system, and module 11 is where one belongs if it turns ' +
      'out to be needed.',
  })
  @ApiOkEnvelope(DiscrepancyDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResolveDiscrepancyDto,
  ) {
    const resolved = await this.reconciliation.resolve(id, dto.notes, user.id);
    return successResponse({ data: resolved, message: 'Discrepancy closed.' });
  }
}
