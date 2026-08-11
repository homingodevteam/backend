import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetBankVerificationDto {
  @ApiProperty({
    description:
      'Records that an admin vouched for this payout destination. The system ' +
      'never holds the full account number, so the check itself is external.',
  })
  @IsBoolean()
  isVerified: boolean;
}
