import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SlideClient } from '@synquic/slide';
import { buildSlideOptions } from '../../config/slide.config';
import { RedisModule } from '../../redis/redis.module';
import { AdminUsersController } from './controllers/admin-users.controller';
import { AuthController } from './controllers/auth.controller';
import { RolesController } from './controllers/roles.controller';
import { ActorTypeGuard } from './guards/actor-type.guard';
import { CityScopeGuard } from './guards/city-scope.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { MockOtpProvider } from './otp/mock-otp-provider.service';
import { OTP_PROVIDER } from './otp/otp-provider.interface';
import {
  SLIDE_CLIENT,
  SLIDE_WIDGET_ID,
  SlideOtpProvider,
} from './otp/slide-otp-provider.service';
import { AdminUsersService } from './services/admin-users.service';
import { AuthService } from './services/auth.service';
import { RolesService } from './services/roles.service';
import { TokenService } from './services/token.service';

/**
 * Owns Role + AdminUser (RBAC needs both together — see the plan note on
 * why AdminUser lives here rather than a dedicated Admin module) and the
 * auth flow for all three actor types. PrismaService is global (see
 * PrismaModule), so OTP-verify can find-or-create Customer/Pro rows
 * without importing CustomersModule/ProsModule — that would create a
 * circular dependency, since both of those import IdentityModule for its
 * guards.
 */
@Module({
  imports: [
    RedisModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController, RolesController, AdminUsersController],
  providers: [
    MockOtpProvider,
    SlideOtpProvider,
    {
      provide: SLIDE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SlideClient => {
        const options = slideOptions(config);
        return new SlideClient({ apiKey: options.apiKey ?? 'mock-not-used' });
      },
    },
    {
      provide: SLIDE_WIDGET_ID,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string =>
        slideOptions(config).widgetId ?? 'mock-not-used',
    },
    {
      provide: OTP_PROVIDER,
      inject: [ConfigService, MockOtpProvider, SlideOtpProvider],
      useFactory: (
        config: ConfigService,
        mock: MockOtpProvider,
        slide: SlideOtpProvider,
      ) => (slideOptions(config).provider === 'slide' ? slide : mock),
    },
    TokenService,
    AuthService,
    RolesService,
    AdminUsersService,
    JwtAuthGuard,
    PermissionsGuard,
    CityScopeGuard,
    ActorTypeGuard,
  ],
  exports: [
    JwtAuthGuard,
    PermissionsGuard,
    CityScopeGuard,
    ActorTypeGuard,
    TokenService,
  ],
})
export class IdentityModule {}

function slideOptions(config: ConfigService) {
  return buildSlideOptions({
    NODE_ENV: config.get<string>('NODE_ENV'),
    OTP_PROVIDER: config.get<string>('OTP_PROVIDER'),
    SLIDE_API_KEY: config.get<string>('SLIDE_API_KEY'),
    SLIDE_WIDGET_ID: config.get<string>('SLIDE_WIDGET_ID'),
    SLIDE_DEFAULT_CHANNEL: config.get<string>('SLIDE_DEFAULT_CHANNEL'),
  });
}
