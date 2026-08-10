import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;

export class RequestProfilePhotoUploadUrlDto {
  @ApiProperty({ enum: PHOTO_CONTENT_TYPES })
  @IsIn(PHOTO_CONTENT_TYPES)
  contentType: (typeof PHOTO_CONTENT_TYPES)[number];
}
