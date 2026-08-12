import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GeocodingModule } from './geocoding/geocoding.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CustomersModule } from './modules/customers/customers.module';
import { IdentityModule } from './modules/identity/identity.module';
import { GeoModule } from './modules/geo/geo.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProsModule } from './modules/pros/pros.module';

// NODE_ENV picks the override file; `.env` is always the fallback beneath it.
// ConfigModule gives the FIRST file that defines a variable precedence, so the
// environment-specific file wins and `.env` fills in whatever it omits.
const nodeEnv = process.env.NODE_ENV ?? 'local';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [`.env.${nodeEnv}`, '.env'],
    }),
    PrismaModule,
    GeocodingModule,
    HealthModule,
    CatalogModule,
    IdentityModule,
    CustomersModule,
    ProsModule,
    BookingsModule,
    // Payments and Geo before Dispatch: dispatch filters the candidate pool by
    // the cash ceiling and by area posting, and Nest instantiates in import
    // order. Both register into module 4's port delegates on construction.
    PaymentsModule,
    GeoModule,
    DispatchModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
