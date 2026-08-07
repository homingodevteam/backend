import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma ProService model — see prisma/schema.prisma. */
export class ProServiceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  proId: string;

  @ApiProperty({
    description: 'No FK check yet — Service catalog (module 3) does not exist',
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
