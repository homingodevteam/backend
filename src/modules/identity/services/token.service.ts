import { randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
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
  ) {}

  async issueTokenPair(user: AuthenticatedUser): Promise<TokenPair> {
    const accessToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        actorType: user.actorType,
        roleId: user.roleId,
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

    await this.redis.del(key);
    return this.issueTokenPair({
      id: payload.sub,
      actorType: payload.actorType,
    });
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
