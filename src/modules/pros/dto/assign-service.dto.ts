import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import type { Proficiency } from '../pros.types';

const PROFICIENCIES: Proficiency[] = ['trainee', 'skilled', 'expert'];

export class AssignServiceDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Must resolve to a service in the catalogue. A draft service is ' +
      'accepted — Pros are trained ahead of a launch.',
  })
  @IsUUID()
  serviceId: string;

  @ApiPropertyOptional({ enum: PROFICIENCIES, default: 'trainee' })
  @IsOptional()
  @IsIn(PROFICIENCIES)
  proficiency?: Proficiency;
}
