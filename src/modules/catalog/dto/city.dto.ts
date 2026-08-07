import { ApiProperty } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma City model — see prisma/schema.prisma. */
export class CityDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  state: string;

  @ApiProperty()
  timezone: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
