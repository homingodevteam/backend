import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { COMMISSION_TYPES } from '../catalog.types';

/** Swagger-only mirror of the Prisma Service model — see prisma/schema.prisma. */
export class ServiceDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  categoryId: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty({
    description:
      'Expected job length. Feeds Dispatch slot sizing and ETA only — it is ' +
      'not a commission input.',
    example: 90,
  })
  durationMinutes: number;

  @ApiProperty({
    type: String,
    example: '599.00',
    description:
      'One flat national price. Serialised as a STRING, not a number: it is a ' +
      'Decimal(12,2) and must not be parsed into a float for money arithmetic.',
  })
  flatPrice: string;

  @ApiProperty()
  supportsInstant: boolean;

  @ApiProperty()
  supportsScheduled: boolean;

  @ApiProperty()
  supportsRecurring: boolean;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/**
 * Everything in {@link ServiceDto} plus the commission configuration. Returned
 * only on admin routes — the platform/Pro split never appears on a
 * customer-facing surface (US-3.2).
 */
export class AdminServiceDto extends ServiceDto {
  @ApiPropertyOptional({ enum: COMMISSION_TYPES, nullable: true })
  commissionType: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '30.00',
    description:
      'Percentage points when type is `percent`; rupees when `flat`.',
  })
  commissionValue: string | null;
}
