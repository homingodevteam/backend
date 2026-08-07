import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Skeleton for now: no route in this pass has a meaningful cityId to check
 * (Booking/Dispatch resources don't exist yet), so this mostly no-ops. It
 * exists because Pro-approval and availability endpoints are documented as
 * city-scoped, and wiring the guard now means those routes only need a
 * decorator later, not a redesign.
 *
 * Looks for cityId on params, then query, then body; an empty
 * `AdminUser.cityScopeJson` means platform-wide access.
 */
@Injectable()
export class CityScopeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      FastifyRequest & {
        user: AuthenticatedUser;
        params: Record<string, string>;
        query: Record<string, string>;
        body: Record<string, unknown>;
      }
    >();

    const user = request.user;
    if (!user || user.actorType !== 'admin') return true;

    const cityId =
      request.params?.cityId ??
      request.query?.cityId ??
      (request.body?.cityId as string | undefined);
    if (!cityId) return true;

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: user.id },
    });
    if (!admin) throw new ForbiddenException('Admin account no longer exists');

    const scope = (admin.cityScopeJson as string[]) ?? [];
    if (scope.length === 0) return true; // platform-wide

    if (!scope.includes(cityId)) {
      throw new ForbiddenException('Outside your city scope');
    }
    return true;
  }
}
