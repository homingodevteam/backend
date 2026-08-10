import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class CreateBankAccountDto {
  @ApiProperty()
  @IsString()
  accountHolderName: string;

  @ApiProperty()
  @IsString()
  @Matches(/^X{4,}\d{4}$/, {
    message:
      'accountNumberMasked must contain only masking Xs and the last 4 digits',
  })
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
