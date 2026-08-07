import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsBoolean, IsUUID } from 'class-validator';

export class BulkAvailabilityDto {
  @ApiProperty({ type: [String] })
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  proIds: string[];

  @ApiProperty()
  @IsBoolean()
  isAvailable: boolean;
}
