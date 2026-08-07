import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude } from 'class-validator';

export class IngestLocationDto {
  @ApiProperty()
  @IsLatitude()
  lat: number;

  @ApiProperty()
  @IsLongitude()
  lng: number;
}
