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
  exports: [CustomersService],
})
export class CustomersModule {}
