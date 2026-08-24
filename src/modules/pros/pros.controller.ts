import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
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
import type { Pro, ProApplication, ProBankAccount } from '../../prisma/client';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { AllowSuspendedProRead } from '../identity/decorators/allow-suspended-pro-read.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import {
  BreakStatusDto,
  ScheduleBreakDto,
  StartBreakDto,
} from './dto/break.dto';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { IngestLocationDto } from './dto/ingest-location.dto';
import { ProLocationDto } from './dto/pro-location.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { KycUploadUrlResponseDto } from './dto/kyc-upload-url-response.dto';
import { DocumentViewUrlResponseDto } from './dto/document-view-url-response.dto';
import { MyDocumentDto } from './dto/my-document.dto';
import { ProApplicationDto } from './dto/pro-application.dto';
import { ProBankAccountDto } from './dto/pro-bank-account.dto';
import { ProDto } from './dto/pro.dto';
import { ProStandingDto } from './dto/pro-standing.dto';
import { RequestKycUploadUrlDto } from './dto/request-kyc-upload-url.dto';
import { RequestProfilePhotoUploadUrlDto } from './dto/request-profile-photo-upload-url.dto';
import { SetProfilePhotoDto } from './dto/set-profile-photo.dto';
import { SubmitProApplicationDto } from './dto/submit-pro-application.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';
import { UpdateProDto } from './dto/update-pro.dto';
import { KycDocumentsService } from './kyc-documents.service';
import { ProApplicationsService } from './pro-applications.service';
import { ProBreaksService } from './pro-breaks.service';
import { ProBankAccountsService } from './pro-bank-accounts.service';
import { ProsService } from './pros.service';
import { ProStandingService } from './pro-standing.service';
import { ProProfilePhotoService } from './pro-profile-photo.service';

@ApiTags('Pros')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('pro')
@Controller('pros/me')
export class ProsController {
  constructor(
    private readonly prosService: ProsService,
    private readonly applicationsService: ProApplicationsService,
    private readonly bankAccountsService: ProBankAccountsService,
    private readonly kycDocumentsService: KycDocumentsService,
    private readonly standingService: ProStandingService,
    private readonly profilePhotoService: ProProfilePhotoService,
    private readonly breaksService: ProBreaksService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get my profile' })
  @ApiOkEnvelope(ProDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  getProfile(@CurrentUser() user: AuthenticatedUser): Promise<Pro> {
    return this.prosService.getById(user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Update my profile' })
  @ApiOkEnvelope(ProDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProDto,
  ): Promise<Pro> {
    return this.prosService.update(user.id, dto);
  }

  @Post('profile-photo/upload-url')
  @ApiOperation({ summary: 'Get a private S3 upload URL for my profile photo' })
  @ApiOkEnvelope(KycUploadUrlResponseDto)
  requestProfilePhotoUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestProfilePhotoUploadUrlDto,
  ): Promise<{ key: string; uploadUrl: string; expiresIn: number }> {
    return this.profilePhotoService.requestUploadUrl(user.id, dto);
  }

  @Patch('profile-photo')
  @ApiOperation({
    summary: 'Attach an issued private S3 photo key to my profile',
  })
  @ApiOkEnvelope(ProDto)
  setProfilePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetProfilePhotoDto,
  ): Promise<Pro> {
    return this.profilePhotoService.setPhoto(user.id, dto.key);
  }

  @Get('standing')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'My standing; rating affects dispatch, acceptance does not',
  })
  @ApiOkEnvelope(ProStandingDto)
  standing(@CurrentUser() user: AuthenticatedUser): Promise<ProStandingDto> {
    return this.standingService.standing(user.id);
  }

  @Get('jobs')
  @AllowSuspendedProRead()
  @ApiOperation({ summary: 'My paginated job history' })
  @ApiOkEnvelope(ProLocationDto)
  jobs(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: HistoryQueryDto,
  ) {
    return this.standingService.jobs(user.id, query);
  }

  @Get('ratings')
  @AllowSuspendedProRead()
  @ApiOperation({ summary: 'Ratings I have received' })
  @ApiOkEnvelope()
  ratings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: HistoryQueryDto,
  ) {
    return this.standingService.ratings(user.id, query);
  }

  @Get('earnings')
  @AllowSuspendedProRead()
  @ApiOperation({ summary: 'Commission-only earnings summary' })
  @ApiOkEnvelope()
  earnings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: HistoryQueryDto,
  ) {
    return this.standingService.earnings(user.id, query);
  }

  @Get('commissions')
  @AllowSuspendedProRead()
  @ApiOperation({ summary: 'My commission history' })
  @ApiOkEnvelope()
  commissions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: HistoryQueryDto,
  ) {
    return this.standingService.commissions(user.id, query);
  }

  // `GET pros/me/payouts` and `GET pros/me/payouts/:id` used to live here.
  //
  // They were written before module 8 existed, reading `CommissionPayout`
  // directly because nothing else could. Module 8 now owns that table and
  // serves both routes from `ProEarningsController`, with the deductions, the
  // line items and the bank reference this version had no way to produce.
  //
  // Two controllers cannot declare the same route — Fastify refuses to start,
  // which is how this was found. See CONFLICTS_AND_DECISIONS #56.

  @Post('location')
  @ApiOperation({
    summary:
      'Push my live GPS position (Redis GEO — this is not stored history)',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.BAD_REQUEST)
  async ingestLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: IngestLocationDto,
  ): Promise<ProLocationDto> {
    return this.prosService.ingestLocation(user.id, dto);
  }

  /*
   * ---------------------------------------------------------------------
   * BREAKS — the one availability control the Pro actually owns
   * ---------------------------------------------------------------------
   * `isAvailable` is the admin roster flag and stays admin-only (US-6.12).
   * These four routes move a SEPARATE pair of columns that dispatch reads
   * alongside it, so a Pro can pause their own dispatch for half an hour
   * without being able to roster themselves on. See `ProBreaksService`.
   */

  @Get('break')
  @ApiOperation({ summary: 'My break state — running, booked, or neither' })
  @ApiOkEnvelope(BreakStatusDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  getBreak(@CurrentUser() user: AuthenticatedUser): Promise<BreakStatusDto> {
    return this.breaksService.status(user.id);
  }

  @Post('break')
  @ApiOperation({
    summary: 'Start a break now — I stop being dispatched until it ends',
  })
  @ApiOkEnvelope(BreakStatusDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.BAD_REQUEST,
    HttpStatus.CONFLICT,
  )
  startBreak(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StartBreakDto,
  ): Promise<BreakStatusDto> {
    return this.breaksService.start(user.id, dto);
  }

  @Post('break/end')
  @ApiOperation({ summary: 'End my break early and go back into dispatch' })
  @ApiOkEnvelope(BreakStatusDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  endBreak(@CurrentUser() user: AuthenticatedUser): Promise<BreakStatusDto> {
    return this.breaksService.end(user.id);
  }

  @Post('break/schedule')
  @ApiOperation({
    summary: 'Book a break window so no job is assigned into it',
  })
  @ApiOkEnvelope(BreakStatusDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
  )
  scheduleBreak(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ScheduleBreakDto,
  ): Promise<BreakStatusDto> {
    return this.breaksService.schedule(user.id, dto);
  }

  @Delete('break/schedule')
  @ApiOperation({ summary: 'Cancel my booked break window' })
  @ApiOkEnvelope(BreakStatusDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  cancelScheduledBreak(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BreakStatusDto> {
    return this.breaksService.cancelScheduled(user.id);
  }

  @Get('applications')
  @ApiOperation({ summary: 'List my onboarding applications' })
  @ApiOkEnvelope(ProApplicationDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  listApplications(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProApplication[]> {
    return this.applicationsService.listForPro(user.id);
  }

  @Post('applications')
  @ApiOperation({ summary: 'Submit (or re-submit) an onboarding application' })
  @ApiOkEnvelope(ProApplicationDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_IMPLEMENTED,
  )
  submitApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitProApplicationDto,
  ): Promise<ProApplication> {
    return this.applicationsService.submit(user.id, dto);
  }

  @Post('kyc/upload-url')
  @ApiOperation({
    summary:
      'Get a presigned S3 PUT URL — PUT the file bytes there, then submit the returned key as aadhaarUrl/panUrl',
  })
  @ApiOkEnvelope(KycUploadUrlResponseDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.BAD_REQUEST)
  requestKycUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestKycUploadUrlDto,
  ): Promise<{ key: string; uploadUrl: string; expiresIn: number }> {
    return this.kycDocumentsService.requestUploadUrl(user.id, dto);
  }

  @Get('documents')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'My KYC documents and their verification state',
  })
  @ApiOkEnvelope(MyDocumentDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  listMyDocuments(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MyDocumentDto[]> {
    return this.kycDocumentsService.listMine(user.id);
  }

  @Get('documents/:docType/view-url')
  @AllowSuspendedProRead()
  @ApiOperation({
    summary: 'A short-lived presigned URL to view one of my own documents',
  })
  @ApiOkEnvelope(DocumentViewUrlResponseDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
  )
  requestMyDocumentViewUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('docType') docType: string,
  ): Promise<{ viewUrl: string; expiresIn: number }> {
    return this.kycDocumentsService.requestMyViewUrl(user.id, docType);
  }

  @Get('bank-accounts')
  @ApiOperation({ summary: 'List my bank accounts' })
  @ApiOkEnvelope(ProBankAccountDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  listBankAccounts(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProBankAccount[]> {
    return this.bankAccountsService.list(user.id);
  }

  @Post('bank-accounts')
  @ApiOperation({ summary: 'Add a bank account' })
  @ApiOkEnvelope(ProBankAccountDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  createBankAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBankAccountDto,
  ): Promise<ProBankAccount> {
    return this.bankAccountsService.create(user.id, dto);
  }

  @Patch('bank-accounts/:id')
  @ApiOperation({ summary: 'Update a bank account' })
  @ApiOkEnvelope(ProBankAccountDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  updateBankAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBankAccountDto,
  ): Promise<ProBankAccount> {
    return this.bankAccountsService.update(user.id, id, dto);
  }
}
