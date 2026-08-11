import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class SuspendProDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Required when the Pro has a live booking. Pre-arrival work is returned to dispatch; arrived/started work remains assigned for manual ops handling.',
  })
  @IsOptional()
  @IsBoolean()
  confirmLiveBookingHandling?: boolean;

  @ApiProperty({
    description: 'Persisted on the Pro as the moderation record',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
