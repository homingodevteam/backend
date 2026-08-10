import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma ProService model — see prisma/schema.prisma. */
export class ProServiceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  proId: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Foreign key to the Service catalogue.',
  })
  serviceId: string;

  @ApiProperty({ enum: ['trainee', 'skilled', 'expert'] })
  proficiency: string;

  @ApiPropertyOptional({ nullable: true })
  certifiedAt: Date | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
