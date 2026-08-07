import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  ALL_PERMISSION_CODES,
  PermissionCode,
} from '../constants/permission-code';

export class CreateRoleDto {
  @ApiProperty({ example: 'ops' })
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ALL_PERMISSION_CODES, isArray: true })
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSION_CODES, { each: true })
  permissionCodes: PermissionCode[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isSystemRole?: boolean;
}
