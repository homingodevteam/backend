import { ApiProperty } from '@nestjs/swagger';

export class ServiceabilityResponseDto {
  @ApiProperty()
  serviceable: boolean;
}
