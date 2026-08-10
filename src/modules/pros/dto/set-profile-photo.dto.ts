import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class SetProfilePhotoDto {
  @ApiProperty({
    description:
      'Private S3 object key returned by POST /pros/me/profile-photo/upload-url',
  })
  @IsString()
  key: string;
}
