import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionCode } from '../constants/permission-code';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

/**
 * Must run after JwtAuthGuard (needs request.user). Only `admin` actors
 * carry permissions — Customer/Pro routes that reach here are a wiring
 * mistake and are rejected rather than silently allowed.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionCode[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user: AuthenticatedUser }>();
    const user = request.user;

    if (!user || user.actorType !== 'admin' || !user.roleId) {
      return this.deny('Admin permissions required');
    }

    const role = await this.prisma.role.findUnique({
      where: { id: user.roleId },
    });
    if (!role) {
      return this.deny('Role no longer exists');
    }

    const permissionCodes = role.permissionCodes as string[];
    const hasAll = required.every((code) => permissionCodes.includes(code));
    if (!hasAll) {
      return this.deny(`Missing permission(s): ${required.join(', ')}`);
    }

    return true;
  }

  private deny(message: string): never {
    throw new ForbiddenException(message);
  }
}
