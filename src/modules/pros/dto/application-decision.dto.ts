import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { ApplicationDecision } from '../pros.types';

const DECISIONS: ApplicationDecision[] = ['approved', 'rejected'];

export class ApplicationDecisionDto {
  @ApiProperty({ enum: DECISIONS })
  @IsIn(DECISIONS)
  decision: ApplicationDecision;

  @ApiPropertyOptional({ description: 'Required when decision is rejected' })
  @IsOptional()
  @IsString()
  reason?: string;
}
