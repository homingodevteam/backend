import { ApiProperty } from '@nestjs/swagger';

export class KycUploadUrlResponseDto {
  @ApiProperty({
    description: 'Submit this as aadhaarUrl/panUrl once the PUT succeeds',
  })
  key: string;

  @ApiProperty({ description: 'Presigned S3 PUT URL, short-lived' })
  uploadUrl: string;

  @ApiProperty({ description: 'Seconds until uploadUrl expires' })
  expiresIn: number;
}
