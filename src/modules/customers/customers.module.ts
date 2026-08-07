import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { AdminCustomersController } from './admin-customers.controller';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [IdentityModule],
  controllers: [CustomersController, AdminCustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
