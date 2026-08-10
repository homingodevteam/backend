import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ApplicationDecision } from '../pros.types';

const DECISIONS: ApplicationDecision[] = [
  'approved',
  'rejected',
  'changes_requested',
];

export class ApplicationDecisionDto {
  @ApiProperty({ enum: DECISIONS })
  @IsIn(DECISIONS)
  decision: ApplicationDecision;

  @ApiPropertyOptional({
    description:
      'Required for rejection or changes_requested; shown to the Pro as the correction message',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
