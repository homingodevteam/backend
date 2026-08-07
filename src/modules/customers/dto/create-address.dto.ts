import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import type { AddressLabel } from '../customers.types';

const LABELS: AddressLabel[] = ['home', 'office', 'other'];

export class CreateAddressDto {
  @ApiProperty({ enum: LABELS })
  @IsIn(LABELS)
  label: AddressLabel;

  @ApiProperty()
  @IsString()
  addressLine: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  landmark?: string;

  @ApiProperty()
  @IsLatitude()
  pinLat: number;

  @ApiProperty()
  @IsLongitude()
  pinLng: number;

  @ApiProperty()
  @IsUUID()
  cityId: string;
}
