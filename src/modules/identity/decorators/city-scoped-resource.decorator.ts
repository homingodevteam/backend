import { SetMetadata } from '@nestjs/common';

export const CITY_RESOURCE_KEY = 'cityScopedResource';
export type CityResource =
  | 'pro'
  | 'proApplication'
  | 'customer'
  | 'bulkPros'
  | 'area'
  | 'areaCopy'
  | 'areas'
  | 'proParam';

export const CityScopedResource = (resource: CityResource) =>
  SetMetadata(CITY_RESOURCE_KEY, resource);
