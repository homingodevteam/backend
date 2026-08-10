import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EXCLUSION_REASONS, ORIGIN_TYPES } from '../dispatch.types';

/**
 * Swagger mirror of `AssignmentCandidate` — the per-attempt audit of who was
 * evaluated and why they won or lost.
 */
export class AssignmentCandidateDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  bookingId: string;

  @ApiProperty({ description: '1 = the first dispatch run for this booking.' })
  attemptNumber: number;

  @ApiProperty()
  proId: string;

  @ApiProperty()
  isWinner: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '**Null means this Pro was never a candidate** — see `excludedReason`. ' +
      'A number means they were ranked, and 1 is the winner.',
  })
  rank: number | null;

  @ApiPropertyOptional({ enum: EXCLUSION_REASONS, nullable: true })
  excludedReason: string | null;

  @ApiPropertyOptional({ enum: ORIGIN_TYPES, nullable: true })
  originType: string | null;

  @ApiPropertyOptional({ nullable: true })
  originLat: number | null;

  @ApiPropertyOptional({ nullable: true })
  originLng: number | null;

  @ApiPropertyOptional({ nullable: true })
  windowStart: Date | null;

  @ApiPropertyOptional({ nullable: true })
  windowEnd: Date | null;

  @ApiPropertyOptional({ nullable: true })
  distanceKm: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Estimated, not measured — straight-line until Geo & Routing exists. ' +
      'Good enough to rank candidates, not to quote a customer.',
  })
  travelTimeMinutes: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '1 = never served this household; 0 = served it most.',
  })
  rotationScore: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '1 = the job exactly fills the free window.',
  })
  durationFitScore: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The **smoothed** rating, not the displayed one: ' +
      '(ratingSum + priorMean × priorWeight) / (ratingCount + priorWeight).',
  })
  ratingScore: number | null;

  @ApiPropertyOptional({ nullable: true })
  offersToday: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The composite the ranking sorts on. Higher wins.',
  })
  finalRankScore: number | null;

  @ApiProperty()
  evaluatedAt: Date;
}
