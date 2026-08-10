import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MinLength,
} from 'class-validator';

export class CreateAdminUserDto {
  @ApiProperty({ example: '+919876500000' })
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid number in international format',
  })
  phone: string;

  @ApiProperty()
  @IsString()
  fullName: string;

  /** The new admin's login identity — also the Google-account match key. */
  @ApiProperty()
  @IsEmail()
  email: string;

  /**
   * Initial password, provisioned directly into Firebase Authentication.
   * Never persisted on AdminUser — Firebase owns it from here on.
   */
  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty()
  @IsUUID()
  roleId: string;

  @ApiPropertyOptional({
    description:
      'City ids this admin may act on. Empty/omitted = platform-wide.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  cityScopeJson?: string[];
}
