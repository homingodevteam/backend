import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class FirebaseLoginDto {
  /** ID token from Firebase client SDK, after a password or Google sign-in. */
  @ApiProperty()
  @IsString()
  idToken: string;
}
