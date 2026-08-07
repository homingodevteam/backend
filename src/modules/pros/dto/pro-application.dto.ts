import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma ProApplication model — see prisma/schema.prisma. */
export class ProApplicationDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  proId: string;

  @ApiProperty({ enum: ['pro', 'customer', 'none'] })
  referredByType: string;

  @ApiPropertyOptional({ nullable: true })
  referredById: string | null;

  @ApiPropertyOptional({ nullable: true })
  submittedAt: Date | null;

  @ApiProperty({
    enum: ['pending', 'docs_review', 'call_pending', 'approved', 'rejected'],
  })
  queueStatus: string;

  @ApiPropertyOptional({ nullable: true, enum: ['manual', 'digilocker'] })
  aadhaarSource: string | null;

  @ApiPropertyOptional({ nullable: true })
  aadhaarUrl: string | null;

  @ApiPropertyOptional({ nullable: true })
  aadhaarNumberMasked: string | null;

  @ApiProperty({ enum: ['pending', 'verified', 'rejected'] })
  aadhaarStatus: string;

  @ApiPropertyOptional({ nullable: true })
  aadhaarVerifiedByAdminId: string | null;

  @ApiPropertyOptional({ nullable: true })
  aadhaarVerifiedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  aadhaarRejectionReason: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ['manual', 'digilocker'] })
  panSource: string | null;

  @ApiPropertyOptional({ nullable: true })
  panUrl: string | null;

  @ApiPropertyOptional({ nullable: true })
  panNumberMasked: string | null;

  @ApiProperty({ enum: ['pending', 'verified', 'rejected'] })
  panStatus: string;

  @ApiPropertyOptional({ nullable: true })
  panVerifiedByAdminId: string | null;

  @ApiPropertyOptional({ nullable: true })
  panVerifiedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  panRejectionReason: string | null;

  @ApiPropertyOptional({ nullable: true })
  digilockerRequestId: string | null;

  @ApiPropertyOptional({ nullable: true })
  digilockerFetchedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  reviewedByAdminId: string | null;

  @ApiPropertyOptional({ nullable: true })
  verificationCallAt: Date | null;

  @ApiPropertyOptional({ nullable: true, enum: ['approved', 'rejected'] })
  decision: string | null;

  @ApiPropertyOptional({ nullable: true })
  decisionAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  rejectionReason: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
