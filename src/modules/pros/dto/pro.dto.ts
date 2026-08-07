import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma Pro model — see prisma/schema.prisma. */
export class ProDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  fullName: string | null;

  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiPropertyOptional({ nullable: true })
  employeeCode: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Bookkeeping only' })
  monthlySalary: unknown;

  @ApiPropertyOptional({ nullable: true })
  salaryUpdatedAt: Date | null;

  @ApiProperty({
    enum: ['applied', 'under_review', 'approved', 'suspended', 'rejected'],
  })
  status: string;

  @ApiPropertyOptional({ nullable: true })
  approvedApplicationId: string | null;

  @ApiProperty({ description: 'Admin-set only, never by the Pro' })
  isAvailable: boolean;

  @ApiPropertyOptional({ nullable: true })
  availabilityUpdatedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  pushToken: string | null;

  @ApiPropertyOptional({ nullable: true })
  pushPlatform: string | null;

  @ApiPropertyOptional({ nullable: true })
  pushTokenUpdatedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  homeBaseLat: number | null;

  @ApiPropertyOptional({ nullable: true })
  homeBaseLng: number | null;

  @ApiPropertyOptional({ nullable: true })
  lastKnownLat: number | null;

  @ApiPropertyOptional({ nullable: true })
  lastKnownLng: number | null;

  @ApiPropertyOptional({ nullable: true })
  lastLocationAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  cityId: string | null;

  @ApiProperty()
  ratingSum: number;

  @ApiProperty()
  ratingCount: number;

  @ApiProperty()
  assignmentsOffered: number;

  @ApiProperty()
  assignmentsAcknowledged: number;

  @ApiPropertyOptional({ nullable: true, description: 'Analytics only' })
  acceptanceRate: number | null;

  @ApiProperty()
  completedJobs: number;

  @ApiPropertyOptional({ nullable: true })
  countersRebuiltAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  approvedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
