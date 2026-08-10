import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
 * A service is created as a **draft** — `isActive` is not settable here.
 * Going live is a separate, validated transition (US-3.11), because a live
 * service with no commission rate leaves Pros unpaid for real work.
 *
 * Commission may be set at creation or later; either way it is required
 * before activation.
 */
export class CreateServiceDto {
  @ApiProperty()
  @IsUUID()
  categoryId: string;

  @ApiProperty({ example: 'Split AC Service' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    example: 90,
    description: 'Expected job length in minutes. Drives Dispatch slot sizing.',
  })
  @IsInt()
  @Min(1)
  @Max(24 * 60)
  durationMinutes: number;

  @ApiProperty({
    type: String,
    example: '599.00',
    description:
      'Sent and returned as a decimal STRING, never a float — this is money.',
  })
  @IsNumberString({ no_symbols: false })
  flatPrice: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  supportsInstant?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  supportsScheduled?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  supportsRecurring?: boolean;
}
