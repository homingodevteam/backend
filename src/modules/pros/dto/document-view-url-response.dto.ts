import { ApiProperty } from '@nestjs/swagger';

export class DocumentViewUrlResponseDto {
  @ApiProperty({ description: 'Presigned S3 GET URL, short-lived' })
  viewUrl: string;

  @ApiProperty({ description: 'Seconds until viewUrl expires' })
  expiresIn: number;
}
