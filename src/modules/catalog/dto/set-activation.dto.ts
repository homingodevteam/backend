import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Used for services, categories and cities alike.
 *
 * Deactivation is always permitted and never cancels work already sold — a
 * committed booking runs to completion against a deactivated service
 * (US-3.7). Activation is the direction that gets checked.
 */
export class SetActivationDto {
  @ApiProperty()
  @IsBoolean()
  isActive: boolean;
}
