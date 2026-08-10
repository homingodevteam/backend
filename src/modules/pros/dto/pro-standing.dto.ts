import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProStandingDto {
  @ApiPropertyOptional({ nullable: true })
  ratingAverage: number | null;

  @ApiProperty()
  ratingCount: number;

  @ApiProperty()
  smoothedRatingScore: number;

  @ApiProperty({ default: true })
  ratingAffectsDispatch: boolean;

  @ApiProperty()
  assignmentsOffered: number;

  @ApiProperty()
  assignmentsAcknowledged: number;

  @ApiPropertyOptional({ nullable: true, description: 'Fraction from 0 to 1' })
  acceptanceRate: number | null;

  @ApiPropertyOptional({ nullable: true })
  acceptanceRatePercent: number | null;

  @ApiProperty({ default: false })
  acceptanceAffectsDispatch: boolean;

  @ApiProperty({ default: false })
  acceptanceAffectsPay: boolean;

  @ApiProperty()
  completedJobs: number;

  @ApiPropertyOptional({ nullable: true })
  countersRebuiltAt: Date | null;
}
