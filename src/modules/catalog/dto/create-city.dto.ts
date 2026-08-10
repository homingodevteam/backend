import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The city registry. Geography is city-level only — there are no zones, no
 * micromarkets and no per-city pricing, so activating a city is the whole of
 * "launching" it (CONFLICTS_AND_DECISIONS #8).
 */
export class CreateCityDto {
  @ApiProperty({ example: 'Indore' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'Madhya Pradesh' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  state: string;

  @ApiProperty({
    example: 'Asia/Kolkata',
    description:
      'IANA zone name. Scheduled slots and recurring plans are interpreted in it.',
  })
  @IsString()
  @MaxLength(64)
  timezone: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Cities are created dark. Launch them with the activation route.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
