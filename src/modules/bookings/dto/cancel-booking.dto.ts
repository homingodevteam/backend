import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CancelBookingDto {
  @ApiProperty({
    description: 'Recorded verbatim on the booking and on the timeline.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

/**
 * Ops-side cancellation. Window E — a job already under way — takes a
 * discretionary refund amount, because "partial, at ops discretion" is a
 * judgement call and deliberately not a formula (US-4.21).
 */
export class AdminCancelBookingDto extends CancelBookingDto {
  @ApiPropertyOptional({
    type: String,
    example: '250.00',
    description:
      'Window E only. Omit elsewhere — windows A–D compute the refund from ' +
      'the window itself.',
  })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  refundAmount?: string;

  @ApiPropertyOptional({
    type: String,
    description:
      'Overrides the configured window-D fee. Never charged when the platform ' +
      'is the party that failed (US-4.22).',
  })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  cancellationFeeAmount?: string;
}
