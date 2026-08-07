import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma CustomerAddress model — see prisma/schema.prisma. */
export class CustomerAddressDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  customerId: string;

  @ApiProperty({ enum: ['home', 'office', 'other'] })
  label: string;

  @ApiProperty()
  addressLine: string;

  @ApiPropertyOptional({ nullable: true })
  landmark: string | null;

  @ApiProperty()
  pinLat: number;

  @ApiProperty()
  pinLng: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'GeoJSON Point, e.g. { type: "Point", coordinates: [lng, lat] }',
  })
  geoPoint: unknown;

  @ApiProperty()
  cityId: string;

  @ApiProperty()
  isDefault: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
