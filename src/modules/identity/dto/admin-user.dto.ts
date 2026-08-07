import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma AdminUser model — see prisma/schema.prisma. */
export class AdminUserDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  phone: string;

  @ApiProperty()
  fullName: string;

  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiProperty()
  roleId: string;

  @ApiProperty({ type: [String], description: 'Empty = platform-wide' })
  cityScopeJson: string[];

  @ApiPropertyOptional({ nullable: true })
  pushToken: string | null;

  @ApiPropertyOptional({ nullable: true })
  pushPlatform: string | null;

  @ApiPropertyOptional({ nullable: true })
  pushTokenUpdatedAt: Date | null;

  @ApiProperty()
  isActive: boolean;

  @ApiPropertyOptional({ nullable: true })
  lastLoginAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
