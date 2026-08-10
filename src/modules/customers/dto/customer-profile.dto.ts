import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CustomerProfileDto {
  @ApiProperty()
  id: string;

  @ApiPropertyOptional({ nullable: true })
  phone: string | null;

  @ApiPropertyOptional({ nullable: true })
  fullName: string | null;

  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiProperty({ enum: ['guest', 'verified'] })
  status: string;

  @ApiPropertyOptional({ nullable: true })
  defaultAddressId: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
