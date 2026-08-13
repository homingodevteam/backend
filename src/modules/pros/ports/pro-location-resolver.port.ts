import { Injectable, Logger } from '@nestjs/common';

export const PRO_LOCATION_RESOLVER_PORT = Symbol('PRO_LOCATION_RESOLVER_PORT');

export interface ProResolvedLocation {
  lat: number;
  lng: number;
  addressLine: string;
  stateName: string | null;
  postalCode: string | null;
  provider: string;
  attribution: string;
  area: {
    areaId: string;
    areaName: string;
    cityId: string;
    cityName: string;
  } | null;
}

export interface ProLocationResolverPort {
  resolve(lat: number, lng: number): Promise<ProResolvedLocation>;
}

@Injectable()
export class ProLocationResolverDelegate implements ProLocationResolverPort {
  private readonly logger = new Logger(ProLocationResolverDelegate.name);
  private real: ProLocationResolverPort | null = null;

  register(implementation: ProLocationResolverPort): void {
    this.real = implementation;
    this.logger.log('Geo address and zone resolution registered for Pro GPS.');
  }

  resolve(lat: number, lng: number): Promise<ProResolvedLocation> {
    if (!this.real) {
      throw new Error('Geo location resolution is not registered');
    }
    return this.real.resolve(lat, lng);
  }
}
