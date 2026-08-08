import { SetMetadata } from '@nestjs/common';

export const CITY_RESOURCE_KEY = 'cityScopedResource';
export type CityResource = 'pro' | 'proApplication' | 'customer' | 'bulkPros';

export const CityScopedResource = (resource: CityResource) =>
  SetMetadata(CITY_RESOURCE_KEY, resource);
