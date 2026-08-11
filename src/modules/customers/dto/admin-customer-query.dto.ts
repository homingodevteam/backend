import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class AdminCustomerQueryDto {
  @ApiPropertyOptional({
    description:
      'Matches phone, email or full name (partial, case-insensitive).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: ['guest', 'verified'] })
  @IsOptional()
  @IsIn(['guest', 'verified'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }): unknown => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isBlocked?: boolean;
}
