import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Launching a city is gated on supply — US-3.9: "activating a city with no
 * approved Pros in it produces bookings nobody can serve."
 *
 * It is a gate, not a prohibition. Ops legitimately opens a city the day
 * before the first cohort is approved, so the override exists — it just has to
 * be deliberate rather than accidental.
 */
export class SetCityActivationDto {
  @ApiProperty()
  @IsBoolean()
  isActive: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Launch even though no approved Pro is based in this city. Without it, ' +
      'activating an unstaffed city is refused with a 409.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeNoSupply?: boolean;
}
