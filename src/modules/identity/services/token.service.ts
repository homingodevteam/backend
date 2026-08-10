import { randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import type {
  ActorType,
  AuthenticatedUser,
} from '../../../common/types/authenticated-user.type';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface AccessTokenPayload {
  sub: string;
  actorType: ActorType;
  roleId?: string;
  accessMode?: 'full' | 'suspended_read_only';
  type: 'access';
}

interface RefreshTokenPayload {
  sub: string;
  actorType: ActorType;
  jti: string;
  type: 'refresh';
}

/**
 * Signs/verifies the JWT pair and owns the Redis-backed session bucket
 * that makes "revoke" and "multi-device sessions" possible even though
 * there is no Session table (the ERD keeps all live state out of Postgres).
 * One Redis key per active refresh token: session:<actorType>:<userId>:<jti>.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async issueTokenPair(user: AuthenticatedUser): Promise<TokenPair> {
    const accessToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        actorType: user.actorType,
        roleId: user.roleId,
        accessMode: user.accessMode ?? 'full',
        type: 'access',
      } satisfies AccessTokenPayload,
      {
        expiresIn: this.config.get<string>('JWT_EXPIRES_IN', '15m'),
      } as JwtSignOptions,
    );

    const jti = randomUUID();
    const refreshExpiresIn = this.config.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    );
    const refreshToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        actorType: user.actorType,
        jti,
        type: 'refresh',
      } satisfies RefreshTokenPayload,
      { expiresIn: refreshExpiresIn } as JwtSignOptions,
    );

    await this.redis.set(
      this.sessionKey(user.actorType, user.id, jti),
      '1',
      this.parseTtlSeconds(refreshExpiresIn),
    );

    return { accessToken, refreshToken };
  }

  /** Verifies an access token. Throws on expiry/signature/shape failure. */
  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    const payload = await this.jwtService
      .verifyAsync<AccessTokenPayload>(token)
      .catch(() => {
        throw new UnauthorizedException('Invalid or expired access token');
      });

    if (payload.type !== 'access') {
      throw new UnauthorizedException('Not an access token');
    }

    return {
      id: payload.sub,
      actorType: payload.actorType,
      roleId: payload.roleId,
      accessMode: payload.accessMode ?? 'full',
    };
  }

  /**
   * Reloads mutable account state instead of trusting JWT claims. This makes
   * blocks, suspensions, admin deactivation, role changes and city-scope
   * changes effective on the next request.
   */
  async resolveCurrentIdentity(
    user: Pick<AuthenticatedUser, 'id' | 'actorType'>,
  ): Promise<AuthenticatedUser> {
    if (user.actorType === 'customer') {
      const customer = await this.prisma.customer.findUnique({
        where: { id: user.id },
        select: { id: true, isBlocked: true },
      });
      if (!customer || customer.isBlocked) {
        throw new UnauthorizedException('This account has been blocked');
      }
      return { ...user, accessMode: 'full' };
    }

    if (user.actorType === 'pro') {
      const pro = await this.prisma.pro.findUnique({
        where: { id: user.id },
        select: { id: true, status: true },
      });
      if (!pro) {
        throw new UnauthorizedException('This Pro account cannot sign in');
      }
      return {
        ...user,
        accessMode: pro.status === 'suspended' ? 'suspended_read_only' : 'full',
      };
    }

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: user.id },
      select: { id: true, roleId: true, cityScopeJson: true, isActive: true },
    });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Admin account is deactivated');
    }

    return {
      ...user,
      roleId: admin.roleId,
      cityScope: (admin.cityScopeJson as string[]) ?? [],
      accessMode: 'full',
    };
  }

  /**
   * Verifies a refresh token, rotates it, and returns a fresh pair.
   *
   * If the token is validly signed and unexpired but its jti is no longer
   * in Redis, it was already rotated away or explicitly revoked — reusing
   * it is a theft signal, so every session for that user is torn down
   * rather than just rejecting the one request.
   */
  async rotateRefreshToken(refreshToken: string): Promise<TokenPair> {
    const payload = await this.jwtService
      .verifyAsync<RefreshTokenPayload>(refreshToken)
      .catch(() => {
        throw new UnauthorizedException('Invalid or expired refresh token');
      });

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Not a refresh token');
    }

    const key = this.sessionKey(payload.actorType, payload.sub, payload.jti);
    const exists = await this.redis.get(key);

    if (!exists) {
      await this.revokeAllSessions(payload.actorType, payload.sub);
      throw new UnauthorizedException('Refresh token already used or revoked');
    }

    let current: AuthenticatedUser;
    try {
      current = await this.resolveCurrentIdentity({
        id: payload.sub,
        actorType: payload.actorType,
      });
    } catch (error) {
      await this.revokeAllSessions(payload.actorType, payload.sub);
      throw error;
    }

    await this.redis.del(key);
    return this.issueTokenPair(current);
  }

  async revokeSession(
    refreshToken: string,
  ): Promise<{ actorType: ActorType; userId: string }> {
    const payload = await this.jwtService
      .verifyAsync<RefreshTokenPayload>(refreshToken)
      .catch(() => {
        throw new UnauthorizedException('Invalid or expired refresh token');
      });

    await this.redis.del(
      this.sessionKey(payload.actorType, payload.sub, payload.jti),
    );
    return { actorType: payload.actorType, userId: payload.sub };
  }

  async revokeAllSessions(actorType: ActorType, userId: string): Promise<void> {
    await this.redis.delByPattern(`session:${actorType}:${userId}:*`);
  }

  private sessionKey(
    actorType: ActorType,
    userId: string,
    jti: string,
  ): string {
    return `session:${actorType}:${userId}:${jti}`;
  }

  /** '15m' | '7d' | '3600' (seconds) -> seconds, for the Redis key TTL. */
  private parseTtlSeconds(duration: string): number {
    const match = /^(\d+)([smhd])?$/.exec(duration.trim());
    if (!match) return 3600;
    const value = Number(match[1]);
    const unit = match[2] ?? 's';
    const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
    return value * multiplier;
  }
}
