import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
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
import type { Pro, ProApplication, ProBankAccount } from '../../prisma/client';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { IngestLocationDto } from './dto/ingest-location.dto';
import { KycUploadUrlResponseDto } from './dto/kyc-upload-url-response.dto';
import { ProApplicationDto } from './dto/pro-application.dto';
import { ProBankAccountDto } from './dto/pro-bank-account.dto';
import { ProDto } from './dto/pro.dto';
import { RequestKycUploadUrlDto } from './dto/request-kyc-upload-url.dto';
import { SubmitProApplicationDto } from './dto/submit-pro-application.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';
import { UpdateProDto } from './dto/update-pro.dto';
import { KycDocumentsService } from './kyc-documents.service';
import { ProApplicationsService } from './pro-applications.service';
import { ProBankAccountsService } from './pro-bank-accounts.service';
import { ProsService } from './pros.service';

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
  ): Promise<void> {
    await this.prosService.ingestLocation(user.id, dto);
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
