import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger-only mirror of the Prisma ProBankAccount model — see prisma/schema.prisma. */
export class ProBankAccountDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  proId: string;

  @ApiProperty()
  accountHolderName: string;

  @ApiProperty()
  accountNumberMasked: string;

  @ApiProperty()
  ifscCode: string;

  @ApiPropertyOptional({ nullable: true })
  upiId: string | null;

  @ApiProperty()
  isPrimary: boolean;

  @ApiProperty()
  isVerified: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
