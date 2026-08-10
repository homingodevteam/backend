import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class SuspendProDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Required when the Pro has a live booking. Pre-arrival work is returned to dispatch; arrived/started work remains assigned for manual ops handling.',
  })
  @IsOptional()
  @IsBoolean()
  confirmLiveBookingHandling?: boolean;

  @ApiPropertyOptional({
    description: 'Required when confirming handling of live bookings',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
