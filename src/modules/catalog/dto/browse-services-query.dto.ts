import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { BOOKING_TYPES, type BookingType } from '../catalog.types';

export class BrowseServicesQueryDto {
  @ApiPropertyOptional({ description: 'Restrict to one category.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description:
      'Case-insensitive substring match on name and description. Two ' +
      'characters minimum — a one-character query matches most of the catalogue.',
    minLength: 2,
  })
  @IsOptional()
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  q?: string;

  @ApiPropertyOptional({
    enum: BOOKING_TYPES,
    description: 'Only services the app can offer through this flow.',
  })
  @IsOptional()
  @IsIn(BOOKING_TYPES)
  bookingType?: BookingType;
}
