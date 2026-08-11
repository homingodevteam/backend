import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { BOOKING_STATUSES, type BookingStatus } from '../booking.types';

export class AdminBookingQueryDto {
  @ApiPropertyOptional({
    enum: BOOKING_STATUSES,
    description: 'Omit to see every status, most recent first.',
  })
  @IsOptional()
  @IsIn(BOOKING_STATUSES)
  status?: BookingStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proId?: string;
}
