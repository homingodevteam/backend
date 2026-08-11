import {
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GoogleGeocoder } from './google.geocoder';

const OPTIONS = {
  apiKey: 'test-key',
  baseUrl: 'https://maps.googleapis.test',
  region: 'in',
  language: 'en',
  timeoutMs: 5000,
  cacheTtlSeconds: 2_592_000,
};

function buildRedis() {
  return { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
}

function build(redis: ReturnType<typeof buildRedis>): GoogleGeocoder {
  return new GoogleGeocoder(OPTIONS, redis as never);
}

function respond(body: unknown, ok = true): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  }) as never;
}

const OK_BODY = {
  status: 'OK',
  results: [
    {
      formatted_address: '12 MG Road, Vijay Nagar, Indore, MP 452010, India',
      address_components: [
        {
          long_name: 'Vijay Nagar',
          short_name: 'Vijay Nagar',
          types: ['sublocality'],
        },
        { long_name: 'Indore', short_name: 'Indore', types: ['locality'] },
        {
          long_name: 'Madhya Pradesh',
          short_name: 'MP',
          types: ['administrative_area_level_1'],
        },
        { long_name: '452010', short_name: '452010', types: ['postal_code'] },
      ],
    },
  ],
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GoogleGeocoder', () => {
  it('normalises a result into the shared shape', async () => {
    const redis = buildRedis();
    respond(OK_BODY);

    const result = await build(redis).reverseGeocode(22.7533, 75.8937);

    expect(result).toEqual({
      addressLine: '12 MG Road, Vijay Nagar, Indore, MP 452010, India',
      cityCandidates: ['Indore'],
      stateName: 'Madhya Pradesh',
      postalCode: '452010',
      provider: 'google',
      attribution: 'Map data ©2026 Google',
    });
  });

  it('sends the key, the pin and the region bias', async () => {
    const redis = buildRedis();
    respond(OK_BODY);

    await build(redis).reverseGeocode(22.7533, 75.8937);

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as URL;
    expect(url.searchParams.get('latlng')).toBe('22.7533,75.8937');
    expect(url.searchParams.get('key')).toBe('test-key');
    expect(url.searchParams.get('region')).toBe('in');
  });

  /**
   * A pin's address does not change, and every cache hit is a request not
   * billed. The key is provider-scoped because the two adapters format
   * `addressLine` quite differently.
   */
  it('caches under a google-scoped key', async () => {
    const redis = buildRedis();
    respond(OK_BODY);

    await build(redis).reverseGeocode(22.7533, 75.8937);

    expect(redis.set).toHaveBeenCalledWith(
      'geo:reverse:google:22.753300:75.893700',
      expect.any(String),
      2_592_000,
    );
  });

  it('serves a cached result without calling Google', async () => {
    const redis = buildRedis();
    redis.get.mockResolvedValue(JSON.stringify({ addressLine: 'cached' }));
    global.fetch = jest.fn() as never;

    const result = await build(redis).reverseGeocode(22.7533, 75.8937);

    expect(result).toMatchObject({ addressLine: 'cached' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  /**
   * ZERO_RESULTS is a real answer about the sea or a desert — a 422 the client
   * can show — while a denied key or an exhausted quota is our problem and must
   * read as a 503, never as "no address here".
   */
  it('separates "nowhere" from "our key is broken"', async () => {
    const redis = buildRedis();

    respond({ status: 'ZERO_RESULTS', results: [] });
    await expect(build(redis).reverseGeocode(0, 0)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    respond({ status: 'REQUEST_DENIED', error_message: 'bad key' });
    await expect(build(redis).reverseGeocode(0, 0)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    respond({ status: 'OVER_QUERY_LIMIT' });
    await expect(build(redis).reverseGeocode(0, 0)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not leak Google’s error text to the caller', async () => {
    const redis = buildRedis();
    respond({ status: 'REQUEST_DENIED', error_message: 'API key not valid' });

    await expect(build(redis).reverseGeocode(0, 0)).rejects.toThrow(
      /Geocoder is unavailable/,
    );
  });

  it('falls back through the administrative levels for an unnamed pin', async () => {
    const redis = buildRedis();
    respond({
      status: 'OK',
      results: [
        {
          formatted_address: 'Unnamed Road, Madhya Pradesh, India',
          address_components: [
            {
              long_name: 'Indore District',
              short_name: 'Indore',
              types: ['administrative_area_level_2'],
            },
            {
              long_name: 'Madhya Pradesh',
              short_name: 'MP',
              types: ['administrative_area_level_1'],
            },
          ],
        },
      ],
    });

    const result = await build(redis).reverseGeocode(22.5, 75.5);

    expect(result.cityCandidates).toEqual(['Indore District']);
    expect(result.postalCode).toBeNull();
  });

  /** A paid quota, so a bulk caller need not pace itself at all. */
  it('declares no politeness interval', () => {
    expect(build(buildRedis()).minIntervalMs).toBe(0);
  });
});
