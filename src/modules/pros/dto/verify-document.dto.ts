import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

const DOC_TYPES = ['aadhaar', 'pan'] as const;
const DECISIONS = ['verified', 'rejected'] as const;

export class VerifyDocumentDto {
  @ApiProperty({ enum: DOC_TYPES })
  @IsIn(DOC_TYPES)
  docType: (typeof DOC_TYPES)[number];

  @ApiProperty({ enum: DECISIONS })
  @IsIn(DECISIONS)
  decision: (typeof DECISIONS)[number];

  @ApiPropertyOptional({ description: 'Required when decision is rejected' })
  @IsOptional()
  @IsString()
  reason?: string;
}
