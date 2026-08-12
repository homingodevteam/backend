import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Rupees as a decimal string — never a float, per the money rule. */
const RUPEES = /^\d+(\.\d{1,2})?$/;

/**
 * Feature 17 — the customer refused to pay.
 *
 * Note there is no amount here, and no partial-collection body anywhere in
 * this module. Cash is `flatPrice` or nothing.
 */
export class DeclineCashDto {
  @ApiProperty({
    example: 'Customer disputed the work and refused to pay',
    description: 'Goes to ops on the billing ticket. Say what happened.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

export class DeclareHandoverDto {
  @ApiProperty({
    type: String,
    example: '4500.00',
    description: 'Rupees, as a string. What you are physically handing over.',
  })
  @IsString()
  @Matches(RUPEES, { message: 'declaredAmount must be rupees, e.g. "4500.00"' })
  declaredAmount: string;
}

export class ConfirmHandoverDto {
  @ApiProperty({
    type: String,
    example: '4500.00',
    description:
      'What you ACTUALLY counted. Deliberately allowed to differ from the ' +
      'declared amount — the balance moves by this figure, not by the claim.',
  })
  @IsString()
  @Matches(RUPEES, {
    message: 'confirmedAmount must be rupees, e.g. "4500.00"',
  })
  confirmedAmount: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class RejectHandoverDto {
  @ApiProperty({ example: 'Pro did not attend the handover appointment' })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

/** What a Pro sees about the money they are carrying. */
export class CashBalanceDto {
  @ApiProperty({ type: String, example: '4500.00' })
  cashInHand: string;

  @ApiProperty({
    type: String,
    example: '10000.00',
    description:
      'Past this, cash jobs stop being assigned. Online work is unaffected.',
  })
  ceiling: string;

  @ApiProperty({
    description:
      'True when the ceiling is breached. Hand over to start receiving cash ' +
      'jobs again — commission is never netted against this balance.',
  })
  isBlockedFromCashJobs: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The open declaration waiting on an admin, if there is one.',
  })
  openHandoverId: string | null;
}

/** Who is standing at the desk with the money. */
export class HandoverProDto {
  @ApiProperty()
  id: string;

  @ApiPropertyOptional({ nullable: true })
  fullName: string | null;

  @ApiProperty()
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  employeeCode: string | null;
}

/** Swagger-only mirror of the Prisma CashHandover model. */
export class CashHandoverDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  proId: string;

  @ApiProperty({ type: String, example: '4500.00' })
  declaredAmount: string;

  @ApiProperty()
  declaredAt: Date;

  @ApiProperty({ enum: ['declared', 'confirmed', 'rejected'] })
  status: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  confirmedAmount: string | null;

  @ApiPropertyOptional({ nullable: true })
  confirmedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  confirmedByAdminId: string | null;

  @ApiPropertyOptional({ nullable: true })
  rejectionReason: string | null;

  @ApiPropertyOptional({ nullable: true })
  notes: string | null;

  @ApiPropertyOptional({
    type: HandoverProDto,
    description:
      'Present on the pending queue, which is worked person by person.',
  })
  pro?: HandoverProDto;
}
