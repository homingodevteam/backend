import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Swagger-only mirror of the Prisma Review model — see prisma/schema.prisma. */
export class ReviewDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  bookingId: string;

  @ApiProperty()
  customerId: string;

  @ApiProperty()
  proId: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  rating: number;

  @ApiPropertyOptional({ nullable: true })
  comment: string | null;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({
    description: 'Hides the comment and tags from the Pro — never the rating',
  })
  isHidden: boolean;

  @ApiPropertyOptional({ nullable: true })
  hiddenReason: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class SetReviewVisibilityDto {
  @ApiProperty()
  @IsBoolean()
  isHidden: boolean;

  @ApiPropertyOptional({
    description: 'Required when hiding, ignored otherwise',
  })
  @ValidateIf((dto: SetReviewVisibilityDto) => dto.isHidden)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}
