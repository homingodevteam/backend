import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumberString } from 'class-validator';
import { COMMISSION_TYPES, type CommissionType } from '../catalog.types';

/**
 * One rate per service — no tiers, no duration bands, no per-city override
 * (ground rules; CONFLICTS_AND_DECISIONS #7).
 *
 * **This rate is what the PRO EARNS, not what the platform keeps.**
 *
 * In most marketplaces "commission" means the platform's cut, so the opposite
 * reading is the natural one and it is wrong here — confirmed with the business
 * on 2026-08-12, CONFLICTS_AND_DECISIONS #52. Setting `percent: 30` pays the Pro
 * 30% and leaves the platform 70%. Read the other way round, every Pro is paid
 * 30% where they should have had 70%, and nothing in the system disagrees with
 * itself until payday.
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
      '**What the Pro earns**, not what the platform keeps (#52). ' +
      '`percent: 30` means the Pro is paid 30% of the job price and the ' +
      'platform keeps 70%.\n\n' +
      'Percentage points (0–100) when type is `percent`; rupees when `flat`. ' +
      'Sent as a decimal string.\n\n' +
      'The admin screen must say this in words next to the input — ' +
      '"Pro earns 30% of the job price" — rather than showing a bare number.',
  })
  @IsNumberString({ no_symbols: false })
  commissionValue: string;
}
