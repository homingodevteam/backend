import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { Proficiency } from '../pros.types';

const PROFICIENCIES: Proficiency[] = ['trainee', 'skilled', 'expert'];

export class AssignServiceDto {
  @ApiProperty({
    description:
      'No FK check yet — Service catalog (module 3) does not exist in this pass',
  })
  @IsString()
  serviceId: string;

  @ApiPropertyOptional({ enum: PROFICIENCIES, default: 'trainee' })
  @IsOptional()
  @IsIn(PROFICIENCIES)
  proficiency?: Proficiency;
}
