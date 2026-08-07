import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma Role model — see prisma/schema.prisma. */
export class RoleDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty({ type: [String] })
  permissionCodes: string[];

  @ApiProperty()
  isSystemRole: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
