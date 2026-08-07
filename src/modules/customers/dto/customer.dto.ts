import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma Customer model — see prisma/schema.prisma. */
export class CustomerDto {
  @ApiProperty()
  id: string;

  @ApiPropertyOptional({ nullable: true })
  deviceId: string | null;

  @ApiPropertyOptional({ nullable: true })
  phone: string | null;

  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiPropertyOptional({ nullable: true })
  fullName: string | null;

  @ApiProperty({ enum: ['guest', 'verified'] })
  status: string;

  @ApiPropertyOptional({ nullable: true })
  verifiedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  razorpayCustomerId: string | null;

  @ApiPropertyOptional({ nullable: true })
  pushToken: string | null;

  @ApiPropertyOptional({ nullable: true })
  pushPlatform: string | null;

  @ApiPropertyOptional({ nullable: true })
  pushTokenUpdatedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  defaultAddressId: string | null;

  @ApiProperty()
  isBlocked: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
