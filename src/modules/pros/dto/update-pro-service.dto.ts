import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { Proficiency } from '../pros.types';

const PROFICIENCIES: Proficiency[] = ['trainee', 'skilled', 'expert'];

export class UpdateProServiceDto {
  @ApiPropertyOptional({ description: 'Per-service suspend/reinstate' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: PROFICIENCIES })
  @IsOptional()
  @IsIn(PROFICIENCIES)
  proficiency?: Proficiency;
}
