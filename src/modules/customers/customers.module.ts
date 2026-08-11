import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { RedisModule } from '../../redis/redis.module';
import { AddressLocationService } from './address-location.service';
import { AdminCustomersController } from './admin-customers.controller';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [IdentityModule, RedisModule],
  controllers: [CustomersController, AdminCustomersController],
  providers: [CustomersService, AddressLocationService],
  // Booking (module 4) resolves the address a job is placed against through
  // this service rather than reading customer_addresses directly.
  //
  // The geocoder used to live here and is now `src/geocoding`, injected as
  // GEOCODER. It moved because module 13 needs it too and `geo` sits
  // downstream of this module — keeping it here would have meant a cycle or a
  // second client with its own cache and its own rate limiter.
  exports: [CustomersService],
})
export class CustomersModule {}
