import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Self-editable fields only. Everything that gates dispatchability
 * (status, isAvailable, cityId, ProService) is admin-controlled and lives
 * on the admin endpoints instead.
 */
export class UpdateProDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  languages?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  emergencyContactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  emergencyContactPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  emergencyContactRelation?: string;

  @ApiPropertyOptional({ description: 'Human-readable home-base address' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  addressLine?: string;

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
