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
import {
  CITY_RESOURCE_KEY,
  type CityResource,
} from '../decorators/city-scoped-resource.decorator';

@Injectable()
export class CityScopeGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      FastifyRequest & {
        user: AuthenticatedUser;
        params: Record<string, string>;
        query: Record<string, string>;
        body: Record<string, unknown>;
      }
    >();
    const scope = request.user?.cityScope ?? [];
    if (request.user?.actorType !== 'admin' || scope.length === 0) return true;

    const explicitCity =
      request.params?.cityId ??
      request.query?.cityId ??
      (request.body?.cityId as string | undefined);
    if (explicitCity && !scope.includes(explicitCity)) this.outside();

    const resource = this.reflector.getAllAndOverride<CityResource>(
      CITY_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!resource) return true;
    const ids = await this.resolveCities(resource, request);
    if (ids.length === 0 || ids.some((cityId) => !scope.includes(cityId))) {
      this.outside();
    }
    return true;
  }

  private async resolveCities(
    resource: CityResource,
    request: { params: Record<string, string>; body: Record<string, unknown> },
  ): Promise<string[]> {
    if (resource === 'area') {
      const row = await this.prisma.area.findUnique({
        where: { id: request.params.id },
        select: { cityId: true },
      });
      return row ? [row.cityId] : [];
    }
    if (resource === 'areaCopy') {
      const sourceAreaId = request.body.sourceAreaId as string;
      const rows = await this.prisma.area.findMany({
        where: { id: { in: [request.params.id, sourceAreaId] } },
        select: { cityId: true },
      });
      return rows.length === 2 ? rows.map((row) => row.cityId) : [];
    }
    if (resource === 'areas') {
      const areaIds = request.body.areaIds as string[];
      const rows = await this.prisma.area.findMany({
        where: { id: { in: areaIds } },
        select: { id: true, cityId: true },
      });
      return rows.length === areaIds.length
        ? rows.map((row) => row.cityId)
        : [];
    }
    if (resource === 'proParam') {
      const row = await this.prisma.pro.findUnique({
        where: { id: request.params.proId },
        select: { cityId: true },
      });
      return row?.cityId ? [row.cityId] : [];
    }
    if (resource === 'pro') {
      const row = await this.prisma.pro.findUnique({
        where: { id: request.params.id },
        select: { cityId: true },
      });
      return row?.cityId ? [row.cityId] : [];
    }
    if (resource === 'proApplication') {
      const row = await this.prisma.proApplication.findUnique({
        where: { id: request.params.id },
        select: { pro: { select: { cityId: true } } },
      });
      return row?.pro.cityId ? [row.pro.cityId] : [];
    }
    if (resource === 'customer') {
      const rows = await this.prisma.customerAddress.findMany({
        where: { customerId: request.params.id },
        select: { cityId: true },
        distinct: ['cityId'],
      });
      return rows.map((row) => row.cityId);
    }
    const proIds = request.body.proIds as string[];
    const rows = await this.prisma.pro.findMany({
      where: { id: { in: proIds } },
      select: { id: true, cityId: true },
    });
    if (rows.length !== proIds.length || rows.some((row) => !row.cityId))
      return [];
    return rows.map((row) => row.cityId!);
  }

  private outside(): never {
    throw new ForbiddenException('Outside your city scope');
  }
}
