import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { TokenService } from '../services/token.service';

/** Verifies `Authorization: Bearer <accessToken>` and attaches request.user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user: AuthenticatedUser }>();

    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    request.user = await this.tokenService.verifyAccessToken(token);
    return true;
  }
}
