import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProLocationAreaDto {
  @ApiProperty() areaId: string;
  @ApiProperty() areaName: string;
  @ApiProperty() cityId: string;
  @ApiProperty() cityName: string;
}

export class ProLocationDto {
  @ApiProperty() lat: number;
  @ApiProperty() lng: number;
  @ApiProperty() addressLine: string;
  @ApiPropertyOptional({ nullable: true }) stateName: string | null;
  @ApiPropertyOptional({ nullable: true }) postalCode: string | null;
  @ApiProperty() provider: string;
  @ApiProperty() attribution: string;
  @ApiPropertyOptional({ type: ProLocationAreaDto, nullable: true })
  area: ProLocationAreaDto | null;
}
