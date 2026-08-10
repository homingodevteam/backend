import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import type {
  DocumentGender,
  DocumentSource,
  ReferredByType,
} from '../pros.types';

const SOURCES: DocumentSource[] = ['manual'];
const REFERRED_BY: ReferredByType[] = ['pro', 'customer', 'none'];
const GENDERS: DocumentGender[] = ['male', 'female', 'transgender'];

export class SubmitProApplicationDto {
  @ApiProperty({
    description: 'Legal name exactly as shown on the KYC document',
  })
  @IsString()
  @MaxLength(200)
  documentFullName: string;

  @ApiProperty({ format: 'date', example: '1995-08-17' })
  @IsDateString({ strict: true })
  documentDateOfBirth: string;

  @ApiProperty({ enum: GENDERS })
  @IsIn(GENDERS)
  documentGender: DocumentGender;

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
  @Matches(/^X{4}-X{4}-\d{4}$/, {
    message: 'aadhaarNumberMasked must use XXXX-XXXX-1234 format',
  })
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
  @Matches(/^X{5}\d{4}[A-Z]$/, {
    message: 'panNumberMasked must use XXXXX1234X format',
  })
  panNumberMasked?: string;
}
