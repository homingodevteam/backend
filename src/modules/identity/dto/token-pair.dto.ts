import { ApiProperty } from '@nestjs/swagger';

/** Swagger-only shape for TokenService's TokenPair — see token.service.ts. */
export class TokenPairDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;
}
