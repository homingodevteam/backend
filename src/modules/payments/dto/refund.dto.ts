import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const RUPEES = /^\d+(\.\d{1,2})?$/;

export class InitiateRefundDto {
  @ApiPropertyOptional({
    type: String,
    example: '299.50',
    description:
      'Rupees. Omit for a full refund of whatever is left uncaptured-back. ' +
      'Partial refunds accumulate — `Order.refundAmount` is cumulative.',
  })
  @IsOptional()
  @IsString()
  @Matches(RUPEES, { message: 'amount must be rupees, e.g. "299.50"' })
  amount?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReconciliationQueryDto {
  @ApiPropertyOptional({
    enum: ['money', 'cash', 'both'],
    default: 'both',
    description:
      '`money` cross-checks captured amounts against Razorpay by order id; ' +
      '`cash` checks completed cash bookings against collections and each ' +
      'Pro’s balance against the collections behind it.',
  })
  @IsOptional()
  @IsIn(['money', 'cash', 'both'])
  scope?: 'money' | 'cash' | 'both';

  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-11T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class DiscrepancyDto {
  @ApiProperty({
    enum: [
      'amount_mismatch',
      'not_paid_at_gateway',
      'gateway_unreachable',
      'duplicate_capture',
      'cash_completed_uncollected',
      'cash_balance_drift',
    ],
  })
  kind: string;

  @ApiProperty({
    description: 'A razorpayOrderId, a bookingNumber or a proId, by kind.',
  })
  reference: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  ours: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  theirs: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  variance: string | null;

  @ApiProperty()
  detail: string;
}

/**
 * Nothing here is persisted — `ReconciliationRun` belongs to module 9 and does
 * not exist yet. Nothing is auto-corrected either: a discrepancy is a question
 * for a human, and making our row match theirs would destroy the only evidence
 * that they ever differed.
 */
export class ReconciliationReportDto {
  @ApiProperty({ enum: ['money', 'cash', 'both'] })
  scope: string;

  @ApiProperty()
  from: string;

  @ApiProperty()
  to: string;

  @ApiProperty()
  ordersScanned: number;

  @ApiProperty()
  bookingsScanned: number;

  @ApiProperty()
  prosScanned: number;

  @ApiProperty()
  discrepancyCount: number;

  @ApiProperty({ type: String, example: '0.00' })
  totalVarianceAmount: string;

  @ApiProperty({ type: [DiscrepancyDto] })
  discrepancies: DiscrepancyDto[];
}

/** Feature 7 — fetched live from Razorpay, never stored. */
export class PaymentAttemptDto {
  @ApiProperty({ example: 'pay_NqRs1234567890' })
  id: string;

  @ApiProperty({ description: 'Paise, exactly as the gateway reports it.' })
  amount: number;

  @ApiProperty({ example: 'captured' })
  status: string;

  @ApiPropertyOptional({ nullable: true })
  method?: string;

  @ApiPropertyOptional({ nullable: true })
  error_code?: string | null;

  @ApiPropertyOptional({ nullable: true })
  error_description?: string | null;
}
