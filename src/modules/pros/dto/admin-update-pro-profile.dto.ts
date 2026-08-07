import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsUUID, Min } from 'class-validator';

/**
 * Admin-only fields — city assignment and the recorded (reference-only,
 * never paid by this system) monthly salary. Separate from UpdateProDto,
 * which is the Pro's own self-editable fields.
 */
export class AdminUpdateProProfileDto {
  @ApiPropertyOptional({ description: 'Which city this Pro operates in' })
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiPropertyOptional({
    description: 'Reference only — never paid by this system',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlySalary?: number;
}
