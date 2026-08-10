import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PHOTO_TYPES, type PhotoType } from '../booking.types';

/**
 * Coordinates travel with every Pro-side transition. They are optional at the
 * DTO layer because a phone can legitimately fail to get a fix, but their
 * absence is recorded as such — US-4.10's "marking arrival from 3 km away is
 * recorded as such" only works if we store whatever we were actually given.
 */
export class TransitionCoordinatesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  lng?: number;
}

export class VerifyStartOtpDto extends TransitionCoordinatesDto {
  @ApiProperty({
    description:
      'The code the customer received. Verified with the provider — never ' +
      'against anything this application stores.',
  })
  @IsString()
  @Length(4, 8)
  code: string;
}

export class RequestPhotoUploadDto {
  @ApiProperty({ enum: PHOTO_TYPES })
  @IsIn(PHOTO_TYPES)
  photoType: PhotoType;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @MaxLength(100)
  contentType: string;
}

export class AttachPhotoDto extends TransitionCoordinatesDto {
  @ApiProperty({ enum: PHOTO_TYPES })
  @IsIn(PHOTO_TYPES)
  photoType: PhotoType;

  @ApiProperty({
    description:
      'The S3 key returned by the upload-url call. Arbitrary keys and keys ' +
      'belonging to another booking are rejected.',
  })
  @IsString()
  @MaxLength(512)
  photoKey: string;
}

export class ForceStartDto {
  @ApiProperty({
    description:
      'Why the OTP was bypassed. Recorded on the timeline and visibly distinct ' +
      'from a verified start — a dispute will turn on exactly this.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class AssignProDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  proId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PhotoUploadUrlResponseDto {
  @ApiProperty()
  photoKey: string;

  @ApiProperty()
  uploadUrl: string;

  @ApiProperty()
  expiresIn: number;
}
