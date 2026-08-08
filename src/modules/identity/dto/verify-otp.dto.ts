import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import type { ActorType } from '../../../common/types/authenticated-user.type';

const ACTOR_TYPES: ActorType[] = ['customer', 'pro', 'admin'];

export class VerifyOtpDto {
  @ApiProperty({ example: '+919876543210' })
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid number in international format',
  })
  phone: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit number' })
  code: string;

  @ApiProperty({ description: 'providerRef returned by /auth/otp/request' })
  @IsString()
  providerRef: string;

  @ApiProperty({ enum: ACTOR_TYPES })
  @IsIn(ACTOR_TYPES)
  actorType: ActorType;

  @ApiPropertyOptional({
    description:
      'Customer only — links a guest session (created from device id) to the verified account',
  })
  @IsOptional()
  @IsString()
  deviceId?: string;
}
