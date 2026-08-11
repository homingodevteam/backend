import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { RedisModule } from '../../redis/redis.module';
import { AddressGeocoderService } from './address-geocoder.service';
import { AddressLocationService } from './address-location.service';
import { AdminCustomersController } from './admin-customers.controller';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [IdentityModule, RedisModule],
  controllers: [CustomersController, AdminCustomersController],
  providers: [CustomersService, AddressGeocoderService, AddressLocationService],
  // Booking (module 4) resolves the address a job is placed against through
  // this service rather than reading customer_addresses directly.
  //
  // AddressGeocoderService is exported for module 13, which reverse-geocodes
  // the centre of each generated grid cell to suggest a name. One adapter, one
  // Redis cache and one rate limiter shared — a second geocoder client would
  // double the request rate against a service whose politeness policy is the
  // whole reason that limiter exists.
  //
  // Longer term this adapter belongs in module 13, which owns geography and is
  // where the Google Places swap will land. Exporting it is the smaller step.
  exports: [CustomersService, AddressGeocoderService],
})
export class CustomersModule {}
