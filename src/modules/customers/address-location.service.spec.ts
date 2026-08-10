import { UnprocessableEntityException } from '@nestjs/common';
import { AddressLocationService } from './address-location.service';

function city(id: string, name: string, state: string) {
  return {
    id,
    name,
    state,
    timezone: 'Asia/Kolkata',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('AddressLocationService', () => {
  it('resolves an active platform city from the geocoder result', async () => {
    const geocoder = {
      reverseGeocode: jest.fn().mockResolvedValue({
        addressLine: 'Vijay Nagar, Indore',
        cityCandidates: ['Indore'],
        stateName: 'Madhya Pradesh',
        attribution: 'OSM',
      }),
    };
    const prisma = {
      city: {
        findMany: jest.fn().mockResolvedValue([city('c1', 'Indore', 'MP')]),
      },
    };
    const service = new AddressLocationService(
      geocoder as never,
      prisma as never,
    );

    await expect(service.preview(22.7, 75.8)).resolves.toEqual({
      addressLine: 'Vijay Nagar, Indore',
      cityId: 'c1',
      cityName: 'Indore',
      serviceable: true,
      attribution: 'OSM',
    });
  });

  it('uses the state only to disambiguate duplicate city names', async () => {
    const geocoder = {
      reverseGeocode: jest.fn().mockResolvedValue({
        addressLine: 'Example',
        cityCandidates: ['Springfield'],
        stateName: 'State Two',
        attribution: 'OSM',
      }),
    };
    const prisma = {
      city: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            city('c1', 'Springfield', 'State One'),
            city('c2', 'Springfield', 'State Two'),
          ]),
      },
    };
    const service = new AddressLocationService(
      geocoder as never,
      prisma as never,
    );

    await expect(service.preview(1, 1)).resolves.toEqual(
      expect.objectContaining({ cityId: 'c2' }),
    );
  });

  it('reports an unsupported preview and refuses to persist it', async () => {
    const geocoder = {
      reverseGeocode: jest.fn().mockResolvedValue({
        addressLine: 'Outside coverage',
        cityCandidates: ['Unknown'],
        stateName: 'Unknown',
        attribution: 'OSM',
      }),
    };
    const prisma = { city: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new AddressLocationService(
      geocoder as never,
      prisma as never,
    );

    await expect(service.preview(1, 1)).resolves.toEqual(
      expect.objectContaining({ cityId: null, serviceable: false }),
    );
    await expect(service.resolveForSave(1, 1)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });
});
