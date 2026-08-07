import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so every feature module injects PrismaService directly instead of
 * each importing TypeOrmModule.forFeature([...]) per entity — one client,
 * imported once here, in AppModule.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
