import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PHOTO_TYPES } from '../booking.types';

/** Swagger-only mirror of the Prisma JobPhotoProof model. */
export class JobPhotoProofDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  bookingId: string;

  @ApiProperty()
  proId: string;

  @ApiProperty({ enum: PHOTO_TYPES })
  photoType: string;

  @ApiProperty({
    description:
      'Private S3 key, not a public URL. Reading it needs a short-lived ' +
      'presigned GET, the same as every other private object here.',
  })
  photoUrl: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Geo-stamp — evidence, not decoration.',
  })
  lat: number | null;

  @ApiPropertyOptional({ nullable: true })
  lng: number | null;

  @ApiProperty()
  capturedAt: Date;
}
