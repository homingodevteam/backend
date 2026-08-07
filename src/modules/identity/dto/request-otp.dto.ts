import { ApiProperty } from '@nestjs/swagger';
import { IsIn, Matches } from 'class-validator';
import type { ActorType } from '../../../common/types/authenticated-user.type';

const ACTOR_TYPES: ActorType[] = ['customer', 'pro', 'admin'];

export class RequestOtpDto {
  @ApiProperty({ example: '+919876543210' })
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone must be a valid number in international format',
  })
  phone: string;

  @ApiProperty({ enum: ACTOR_TYPES })
  @IsIn(ACTOR_TYPES)
  actorType: ActorType;
}
