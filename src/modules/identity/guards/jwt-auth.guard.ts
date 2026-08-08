import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { ALLOW_SUSPENDED_PRO_READ_KEY } from '../decorators/allow-suspended-pro-read.decorator';
import { TokenService } from '../services/token.service';

/** Verifies `Authorization: Bearer <accessToken>` and attaches request.user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user: AuthenticatedUser }>();

    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const tokenUser = await this.tokenService.verifyAccessToken(token);
    try {
      request.user = await this.tokenService.resolveCurrentIdentity(tokenUser);
    } catch (error) {
      await this.tokenService.revokeAllSessions(
        tokenUser.actorType,
        tokenUser.id,
      );
      throw error;
    }

    if (request.user.accessMode === 'suspended_read_only') {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        ALLOW_SUSPENDED_PRO_READ_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (!allowed) {
        throw new ForbiddenException(
          'Suspended Pros may only view earnings and payout history',
        );
      }
    }
    return true;
  }
}
