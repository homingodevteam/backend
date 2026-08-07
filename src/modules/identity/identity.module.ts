import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
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
import { AdminUsersService } from './services/admin-users.service';
import { AuditLogService } from './services/audit-log.service';
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
    { provide: OTP_PROVIDER, useClass: MockOtpProvider },
    TokenService,
    AuthService,
    AuditLogService,
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
    AuditLogService,
    TokenService,
  ],
})
export class IdentityModule {}
