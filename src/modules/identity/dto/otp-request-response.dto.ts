import { ApiProperty } from '@nestjs/swagger';

export class OtpRequestResponseDto {
  @ApiProperty({
    description: 'Opaque reference — pass it back to /auth/otp/verify',
  })
  providerRef: string;
}
