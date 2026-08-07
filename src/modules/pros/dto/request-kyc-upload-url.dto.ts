import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

const DOC_TYPES = ['aadhaar', 'pan'] as const;
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;

export class RequestKycUploadUrlDto {
  @ApiProperty({ enum: DOC_TYPES })
  @IsIn(DOC_TYPES)
  docType: (typeof DOC_TYPES)[number];

  @ApiProperty({ enum: ALLOWED_CONTENT_TYPES })
  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType: (typeof ALLOWED_CONTENT_TYPES)[number];
}
