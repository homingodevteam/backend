import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Self-editable fields only. Everything that gates dispatchability
 * (status, isAvailable, cityId, ProService) is admin-controlled and lives
 * on the admin endpoints instead.
 */
export class UpdateProDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'Set once at onboarding — fallback dispatch origin',
  })
  @IsOptional()
  @IsLatitude()
  homeBaseLat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  homeBaseLng?: number;
}
