import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

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
