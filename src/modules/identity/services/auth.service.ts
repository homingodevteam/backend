import {
  Injectable,
  Inject,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { GuestSessionDto } from '../dto/guest-session.dto';
import { RequestOtpDto } from '../dto/request-otp.dto';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import { OTP_PROVIDER, type OtpProvider } from '../otp/otp-provider.interface';
import { TokenPair, TokenService } from './token.service';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';

const OTP_REQUEST_LIMIT = 5;
const OTP_REQUEST_WINDOW_SECONDS = 3600;

@Injectable()
export class AuthService {
  constructor(
    @Inject(OTP_PROVIDER) private readonly otpProvider: OtpProvider,
    private readonly tokenService: TokenService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async requestOtp(dto: RequestOtpDto): Promise<{ providerRef: string }> {
    const attempts = await this.redis.incrWithExpiry(
      `otp:rl:${dto.phone}`,
      OTP_REQUEST_WINDOW_SECONDS,
    );
    if (attempts > OTP_REQUEST_LIMIT) {
      throw new UnauthorizedException(
        'Too many OTP requests for this number — try again later',
      );
    }

    // Admins are never self-provisioned — fail fast rather than sending a
    // code to a phone that could never complete a login anyway.
    if (dto.actorType === 'admin') {
      const admin = await this.prisma.adminUser.findUnique({
        where: { phone: dto.phone },
      });
      if (!admin) {
        throw new NotFoundException('No admin account for this number');
      }
      if (!admin.isActive) {
        throw new UnauthorizedException('Admin account is deactivated');
      }
    }

    return this.otpProvider.sendOtp(dto.phone);
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<TokenPair> {
    const isValid = await this.otpProvider.verifyOtp(
      dto.phone,
      dto.code,
      dto.providerRef,
    );
    if (!isValid) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    const user = await this.resolveActor(dto);
    return this.tokenService.issueTokenPair(user);
  }

  /** Guest customer session from a bare device id — no phone/OTP required. */
  async createGuestSession(dto: GuestSessionDto): Promise<TokenPair> {
    let customer = await this.prisma.customer.findUnique({
      where: { deviceId: dto.deviceId },
    });

    customer ??= await this.prisma.customer.create({
      data: { deviceId: dto.deviceId, status: 'guest' },
    });

    return this.tokenService.issueTokenPair({
      id: customer.id,
      actorType: 'customer',
    });
  }

  refreshTokens(refreshToken: string): Promise<TokenPair> {
    return this.tokenService.rotateRefreshToken(refreshToken);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokenService.revokeSession(refreshToken);
  }

  async logoutAll(user: AuthenticatedUser): Promise<void> {
    await this.tokenService.revokeAllSessions(user.actorType, user.id);
  }

  private async resolveActor(dto: VerifyOtpDto): Promise<AuthenticatedUser> {
    if (dto.actorType === 'customer') {
      return this.resolveCustomer(dto);
    }
    if (dto.actorType === 'pro') {
      return this.resolvePro(dto.phone);
    }
    return this.resolveAdmin(dto.phone);
  }

  private async resolveCustomer(dto: VerifyOtpDto): Promise<AuthenticatedUser> {
    let customer = await this.prisma.customer.findUnique({
      where: { phone: dto.phone },
    });

    if (!customer && dto.deviceId) {
      // Guest -> verified upgrade in place, so the customer id (and every
      // address/booking already tied to it) survives the phone attach.
      const guest = await this.prisma.customer.findUnique({
        where: { deviceId: dto.deviceId },
      });
      if (guest && guest.status === 'guest') {
        customer = await this.prisma.customer.update({
          where: { id: guest.id },
          data: {
            phone: dto.phone,
            status: 'verified',
            verifiedAt: new Date(),
          },
        });
      }
    }

    customer ??= await this.prisma.customer.create({
      data: { phone: dto.phone, status: 'verified', verifiedAt: new Date() },
    });

    if (customer.isBlocked) {
      throw new UnauthorizedException('This account has been blocked');
    }

    return { id: customer.id, actorType: 'customer' };
  }

  private async resolvePro(phone: string): Promise<AuthenticatedUser> {
    let pro = await this.prisma.pro.findUnique({ where: { phone } });

    // First OTP login is the entry point for "in-app self-application" —
    // the actual ProApplication is submitted afterward.
    pro ??= await this.prisma.pro.create({
      data: { phone, status: 'applied' },
    });

    if (pro.status === 'suspended' || pro.status === 'rejected') {
      throw new UnauthorizedException(`Account is ${pro.status}`);
    }

    return { id: pro.id, actorType: 'pro' };
  }

  private async resolveAdmin(phone: string): Promise<AuthenticatedUser> {
    const admin = await this.prisma.adminUser.findUnique({ where: { phone } });
    if (!admin) {
      throw new NotFoundException('No admin account for this number');
    }
    if (!admin.isActive) {
      throw new UnauthorizedException('Admin account is deactivated');
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    return { id: admin.id, actorType: 'admin', roleId: admin.roleId };
  }
}
