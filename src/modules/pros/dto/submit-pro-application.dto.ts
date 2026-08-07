import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { DocumentSource, ReferredByType } from '../pros.types';

const SOURCES: DocumentSource[] = ['manual', 'digilocker'];
const REFERRED_BY: ReferredByType[] = ['pro', 'customer', 'none'];

export class SubmitProApplicationDto {
  @ApiPropertyOptional({ enum: REFERRED_BY, default: 'none' })
  @IsOptional()
  @IsIn(REFERRED_BY)
  referredByType?: ReferredByType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  referredById?: string;

  @ApiProperty({ enum: SOURCES })
  @IsIn(SOURCES)
  aadhaarSource: DocumentSource;

  @ApiPropertyOptional({
    description:
      'The S3 key returned by POST /pros/me/kyc/upload-url (docType: aadhaar) — required when aadhaarSource is manual',
  })
  @IsOptional()
  @IsString()
  aadhaarUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  aadhaarNumberMasked?: string;

  @ApiProperty({ enum: SOURCES })
  @IsIn(SOURCES)
  panSource: DocumentSource;

  @ApiPropertyOptional({
    description:
      'The S3 key returned by POST /pros/me/kyc/upload-url (docType: pan) — required when panSource is manual',
  })
  @IsOptional()
  @IsString()
  panUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  panNumberMasked?: string;
}
