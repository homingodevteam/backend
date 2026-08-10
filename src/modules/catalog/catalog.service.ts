import { HttpStatus, Inject, Injectable, forwardRef } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { City } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProsService } from '../pros/pros.service';
import { CreateCityDto } from './dto/create-city.dto';
import { UpdateCityDto } from './dto/update-city.dto';

/**
 * The city registry.
 *
 * Geography is city-level only — no zones, no micromarkets, and no per-city
 * pricing or per-city service availability. `isActive` therefore carries the
 * entire meaning of "we operate here": it is what module 2's serviceability
 * check reads, and the only thing standing between a launched city and a dark
 * one. See CONFLICTS_AND_DECISIONS #8.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    // Catalog needs Pro supply counts to gate a launch, and Pro Management
    // needs the catalogue to validate service assignments. Genuinely
    // bidirectional, hence forwardRef on both sides.
    @Inject(forwardRef(() => ProsService))
    private readonly pros: ProsService,
  ) {}

  findActiveCities(): Promise<City[]> {
    return this.prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  findById(id: string): Promise<City | null> {
    return this.prisma.city.findUnique({ where: { id } });
  }

  /** Admin listing — includes cities that have not been launched yet. */
  findAll(): Promise<City[]> {
    return this.prisma.city.findMany({ orderBy: { name: 'asc' } });
  }

  /** Created dark by default: launching is a separate, deliberate call. */
  create(dto: CreateCityDto): Promise<City> {
    return this.prisma.city.create({
      data: {
        name: dto.name,
        state: dto.state,
        timezone: dto.timezone,
        isActive: dto.isActive ?? false,
      },
    });
  }

  async update(id: string, dto: UpdateCityDto): Promise<City> {
    await this.getOrFail(id);
    return this.prisma.city.update({ where: { id }, data: { ...dto } });
  }

  /**
   * Deactivating a city stops new bookings there. It deliberately does not
   * touch Pros, addresses or committed work already in that city — the same
   * rule as retiring a service (US-3.7): never cancel what has been sold.
   *
   * Activating is gated on supply (US-3.9). A city with no approved Pro
   * accepts bookings the dispatch engine will never be able to fill, and the
   * customer finds out by waiting. Overridable, because opening a city ahead
   * of the first approved cohort is a legitimate thing to do — it just has to
   * be a decision rather than an accident.
   */
  async setActivation(
    id: string,
    isActive: boolean,
    acknowledgeNoSupply = false,
  ): Promise<City> {
    await this.getOrFail(id);

    if (isActive && !acknowledgeNoSupply) {
      const approvedPros = await this.pros.countApprovedInCity(id);
      if (approvedPros === 0) {
        throw apiError(
          'No approved Pro is based in this city, so bookings placed here could not be filled. Re-send with acknowledgeNoSupply to launch anyway.',
          HttpStatus.CONFLICT,
          [
            {
              field: 'isActive',
              message: 'City has no approved Pros',
              code: 'CITY_HAS_NO_SUPPLY',
            },
          ],
        );
      }
    }

    return this.prisma.city.update({ where: { id }, data: { isActive } });
  }

  private async getOrFail(id: string): Promise<City> {
    const city = await this.findById(id);
    if (!city) throw apiError('City not found', HttpStatus.NOT_FOUND);
    return city;
  }
}
