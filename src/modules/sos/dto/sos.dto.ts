import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { SOS_STATUSES, type SosStatus } from '../sos.types';

/**
 * Raising an alarm.
 *
 * ---------------------------------------------------------------------------
 * ALMOST EVERYTHING HERE IS OPTIONAL, AND THAT IS THE DESIGN
 * ---------------------------------------------------------------------------
 * The only required field is `raisedAt`. An alarm that could be rejected for a
 * missing field is an alarm that fails at the moment it is needed — no GPS fix
 * indoors, no booking because the Safety screen was opened from the account
 * tab, no address because the profile is thin. Every one of those still gets
 * through, and ops gets whatever the device could gather.
 *
 * The validation that remains is about not corrupting the row: a latitude that
 * is not a latitude is worse than no latitude, because it puts a pin somewhere
 * confident and wrong.
 */
export class CreateSosAlertDto {
  @ApiProperty({
    description:
      'When the customer actually pressed, from the device clock. Sent ' +
      'rather than inferred because a queued alarm can reach us minutes ' +
      'later on a bad connection, and the gap is what ops must not lose.',
    example: '2026-08-22T09:14:03.000Z',
  })
  @IsISO8601()
  raisedAt: string;

  @ApiPropertyOptional({
    description:
      'The visit this was raised during, when there is one. Absent when the ' +
      'Safety screen was opened from the account tab.',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({
    description:
      'Where the device believed it was. Null when no fix could be taken in ' +
      'the seconds an alarm allows — which is never a reason to reject it.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({
    description: 'Metres of uncertainty the platform reported with the fix.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  locationAccuracyM?: number;

  @ApiPropertyOptional({
    description:
      'When the fix was taken. A cached position is legitimate; how stale it ' +
      'is decides whether a dispatcher trusts it.',
  })
  @IsOptional()
  @IsISO8601()
  locationAt?: string;

  @ApiPropertyOptional({
    description:
      'The context snapshot, copied by the device at press time. Stored as ' +
      'sent and never refreshed from the live booking — an SOS is evidence.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  addressText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  serviceTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  proName?: string;

  @ApiPropertyOptional({
    description:
      "The app's own id for this press. Retrying a queued alarm with the " +
      'same key returns the original row with 200 rather than raising a ' +
      'second incident.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientAlertId?: string;
}

/**
 * Standing an alarm down.
 *
 * Takes no reason and no explanation. Asking "why?" at the end of a false
 * alarm is how you teach somebody to hesitate next time — see US-11.4.
 */
export class StandDownSosAlertDto {
  @ApiPropertyOptional({
    enum: ['false_alarm', 'closed'],
    default: 'false_alarm',
    description:
      '`false_alarm` — the customer is safe and says so. Carries no ' +
      'consequence of any kind. `closed` is for an alarm that ran its course.',
  })
  @IsOptional()
  @IsIn(['false_alarm', 'closed'])
  status?: 'false_alarm' | 'closed';
}

/** Ops acknowledging that a human has the alert. */
export class AcknowledgeSosAlertDto {
  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'What the responder is doing, for the next person on shift.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/**
 * Closing an alert from the console.
 *
 * `resolutionNotes` is required here, unlike on the customer's own stand-down.
 * An incident closed by ops with no account of what happened is one nobody can
 * review afterwards — the same rule the dispute thread enforces.
 */
export class ResolveSosAlertDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  resolutionNotes: string;

  @ApiPropertyOptional({ enum: ['closed', 'false_alarm'], default: 'closed' })
  @IsOptional()
  @IsIn(['closed', 'false_alarm'])
  status?: 'closed' | 'false_alarm';
}

export class SosAlertDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: SOS_STATUSES }) status: SosStatus;
  @ApiProperty() raisedAt: string;
  @ApiProperty() createdAt: string;

  @ApiPropertyOptional() bookingId?: string | null;
  @ApiPropertyOptional() lat?: number | null;
  @ApiPropertyOptional() lng?: number | null;
  @ApiPropertyOptional() locationAccuracyM?: number | null;
  @ApiPropertyOptional() locationAt?: string | null;

  @ApiPropertyOptional() addressText?: string | null;
  @ApiPropertyOptional() serviceTitle?: string | null;
  @ApiPropertyOptional() proName?: string | null;

  @ApiPropertyOptional() acknowledgedAt?: string | null;
  @ApiPropertyOptional() resolvedAt?: string | null;
  @ApiPropertyOptional() resolutionNotes?: string | null;

  @ApiProperty({
    description:
      'Whether a human has picked this up. The one thing the app shows the ' +
      'customer, because "we have it" is the only reassurance that counts.',
  })
  acknowledged: boolean;
}
