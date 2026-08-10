import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  RECURRENCE_FREQUENCIES,
  type RecurrenceFrequency,
} from '../booking.types';

export class CreateRecurringPlanDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  addressId: string;

  @ApiProperty({ enum: RECURRENCE_FREQUENCIES })
  @IsIn(RECURRENCE_FREQUENCIES)
  frequency: RecurrenceFrequency;

  @ApiPropertyOptional({
    type: [Number],
    example: [1, 4],
    description:
      'Sunday = 0. Required for weekly and biweekly, ignored otherwise.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  @ApiProperty({
    example: '09:30',
    description:
      'Wall-clock time, interpreted in the timezone of the address’s city — ' +
      'not UTC. A customer means 9:30 where they live.',
  })
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'timeOfDay must be HH:mm',
  })
  timeOfDay: string;

  @ApiProperty({ example: '2026-08-15' })
  @Type(() => Date)
  @IsDate()
  startDate: Date;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endDate?: Date;
}

export class UpdateRecurringPlanDto {
  @ApiPropertyOptional({
    description: 'Pause a plan without losing it — set false, then true again.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: '10:00' })
  @IsOptional()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'timeOfDay must be HH:mm',
  })
  timeOfDay?: string;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endDate?: Date;
}

/** Swagger-only mirror of the Prisma RecurringPlan model. */
export class RecurringPlanDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  customerId: string;

  @ApiProperty()
  serviceId: string;

  @ApiProperty()
  addressId: string;

  @ApiProperty({ enum: RECURRENCE_FREQUENCIES })
  frequency: string;

  @ApiProperty({ type: [Number] })
  daysOfWeek: number[];

  @ApiProperty({ example: '09:30' })
  timeOfDay: string;

  @ApiProperty()
  startDate: Date;

  @ApiPropertyOptional({ nullable: true })
  endDate: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'When the next occurrence is due to be generated.',
  })
  nextRunAt: Date | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
