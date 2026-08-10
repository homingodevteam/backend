import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumberString } from 'class-validator';
import { COMMISSION_TYPES, type CommissionType } from '../catalog.types';

/**
 * One rate per service — no tiers, no duration bands, no per-city override
 * (ground rules; CONFLICTS_AND_DECISIONS #7).
 *
 * Applies to **future** completions only. `BookingCommission` snapshots the
 * type and value at computation time, so changing a rate today never rewrites
 * what was paid yesterday (US-3.10).
 */
export class SetCommissionDto {
  @ApiProperty({
    enum: COMMISSION_TYPES,
    description:
      '`percent` scales with the price; `flat` does not. A price cut therefore ' +
      "reduces the platform's margin under `flat`, and both shares under " +
      '`percent` (US-8.4).',
  })
  @IsIn(COMMISSION_TYPES)
  commissionType: CommissionType;

  @ApiProperty({
    type: String,
    example: '30.00',
    description:
      'Percentage points (0–100) when type is `percent`; rupees when `flat`. ' +
      'Sent as a decimal string.',
  })
  @IsNumberString({ no_symbols: false })
  commissionValue: string;
}
