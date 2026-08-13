import { Injectable } from '@nestjs/common';
import type {
  ProLocationResolverPort,
  ProResolvedLocation,
} from '../pros/ports/pro-location-resolver.port';
import { LocationService } from './location.service';

@Injectable()
export class ProLocationAdapter implements ProLocationResolverPort {
  constructor(private readonly location: LocationService) {}

  async resolve(lat: number, lng: number): Promise<ProResolvedLocation> {
    return { lat, lng, ...(await this.location.reverseGeocode(lat, lng)) };
  }
}
