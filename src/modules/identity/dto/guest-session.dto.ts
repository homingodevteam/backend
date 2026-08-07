import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class GuestSessionDto {
  @ApiProperty({ description: 'Stable per-install device identifier' })
  @IsString()
  @MinLength(8)
  deviceId: string;
}
