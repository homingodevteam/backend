import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';

export class ReverseGeocodeQueryDto {
  @Type(() => Number)
  @IsLatitude()
  pinLat: number;

  @Type(() => Number)
  @IsLongitude()
  pinLng: number;
}
