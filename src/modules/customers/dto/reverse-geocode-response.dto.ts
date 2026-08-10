import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReverseGeocodeResponseDto {
  @ApiProperty()
  addressLine: string;

  @ApiPropertyOptional({ nullable: true })
  cityId: string | null;

  @ApiPropertyOptional({ nullable: true })
  cityName: string | null;

  @ApiProperty()
  serviceable: boolean;

  @ApiProperty()
  attribution: string;
}
