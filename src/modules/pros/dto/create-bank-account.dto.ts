import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateBankAccountDto {
  @ApiProperty()
  @IsString()
  accountHolderName: string;

  @ApiProperty()
  @IsString()
  accountNumberMasked: string;

  @ApiProperty()
  @IsString()
  ifscCode: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  upiId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
