import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetAvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  isAvailable: boolean;
}
