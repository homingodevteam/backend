import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { City } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GEOCODER,
  type GeocoderPort,
  type ReverseGeocodeResult,
} from '../../geocoding/geocoding.types';

export interface ResolvedAddressLocation {
  addressLine: string;
  cityId: string | null;
  cityName: string | null;
  serviceable: boolean;
  attribution: string;
}

@Injectable()
export class AddressLocationService {
  constructor(
    @Inject(GEOCODER) private readonly geocoder: GeocoderPort,
    private readonly prisma: PrismaService,
  ) {}

  async preview(
    pinLat: number,
    pinLng: number,
  ): Promise<ResolvedAddressLocation> {
    const geocoded = await this.geocoder.reverseGeocode(pinLat, pinLng);
    const city = await this.matchActiveCity(geocoded);
    return {
      addressLine: geocoded.addressLine,
      cityId: city?.id ?? null,
      cityName: city?.name ?? null,
      serviceable: !!city,
      attribution: geocoded.attribution,
    };
  }

  async resolveForSave(
    pinLat: number,
    pinLng: number,
  ): Promise<{
    cityId: string;
    suggestedAddressLine: string;
  }> {
    const result = await this.preview(pinLat, pinLng);
    if (!result.cityId) {
      throw new UnprocessableEntityException(
        'This pin is outside the cities currently served by the platform',
      );
    }
    return {
      cityId: result.cityId,
      suggestedAddressLine: result.addressLine,
    };
  }

  private async matchActiveCity(
    geocoded: ReverseGeocodeResult,
  ): Promise<City | null> {
    const cities = await this.prisma.city.findMany({
      where: { isActive: true },
    });
    const candidates = new Set(geocoded.cityCandidates.map(normalize));
    const nameMatches = cities.filter((city) =>
      candidates.has(normalize(city.name)),
    );
    if (nameMatches.length === 1) return nameMatches[0];
    if (nameMatches.length === 0) return null;

    const normalizedState = normalize(geocoded.stateName ?? '');
    return (
      nameMatches.find((city) => normalize(city.state) === normalizedState) ??
      null
    );
  }
}

function normalize(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-IN')
    .replace(/[^a-z0-9]/g, '');
}
