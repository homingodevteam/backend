import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body: string;
}

/**
 * Swagger-only mirror of the Prisma ChatMessage model.
 *
 * Note what is **not** here: no phone number, no name, no contact detail of
 * any kind. `senderType` plus `senderId` is all either side gets — the whole
 * reason the thread exists rather than exchanging numbers.
 */
export class ChatMessageDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  bookingId: string;

  @ApiProperty({ enum: ['customer', 'pro'] })
  senderType: string;

  @ApiProperty()
  senderId: string;

  @ApiProperty()
  body: string;

  @ApiPropertyOptional({ nullable: true })
  attachmentUrl: string | null;

  @ApiProperty()
  sentAt: Date;

  @ApiPropertyOptional({ nullable: true })
  readAt: Date | null;
}
