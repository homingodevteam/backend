import { Injectable } from '@nestjs/common';
import type { City } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  findActiveCities(): Promise<City[]> {
    return this.prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  findById(id: string): Promise<City | null> {
    return this.prisma.city.findUnique({ where: { id } });
  }
}
