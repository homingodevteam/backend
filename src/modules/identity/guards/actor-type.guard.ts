import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type {
  ActorType,
  AuthenticatedUser,
} from '../../../common/types/authenticated-user.type';
import { ACTOR_TYPE_KEY } from '../decorators/require-actor-type.decorator';

/** Must run after JwtAuthGuard. */
@Injectable()
export class ActorTypeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<ActorType | undefined>(
      ACTOR_TYPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user: AuthenticatedUser }>();

    if (request.user?.actorType !== required) {
      throw new ForbiddenException(
        `This endpoint is for ${required} accounts only`,
      );
    }
    return true;
  }
}
