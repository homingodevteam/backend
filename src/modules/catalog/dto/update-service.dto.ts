import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Neither `isActive` nor the commission fields are settable here — they have
 * their own endpoints, so that repricing a service and changing what a Pro
 * earns from it stay visibly separate operations (US-8.4).
 *
 * Editing price or duration never touches a booking already placed
 * (US-3.5, US-3.6): module 4 snapshots both onto the booking at creation.
 */
export class UpdateServiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 60)
  durationMinutes?: number;

  @ApiPropertyOptional({ type: String, example: '649.00' })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  flatPrice?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  supportsInstant?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  supportsScheduled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  supportsRecurring?: boolean;
}
