import { ServiceUnavailableException } from '@nestjs/common';
import { NominatimGeocoder } from './nominatim.geocoder';

function buildDeps(values: Record<string, string> = {}) {
  const config = {
    get: jest.fn((name: string, fallback?: string) => values[name] ?? fallback),
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    setIfAbsent: jest.fn().mockResolvedValue(true),
  };
  return {
    config,
    redis,
    service: new NominatimGeocoder(config as never, redis as never),
  };
}

describe('NominatimGeocoder', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns a coordinate cache hit without calling Nominatim', async () => {
    const deps = buildDeps();
    const cached = {
      addressLine: 'Cached address',
      cityCandidates: ['Indore'],
      stateName: 'Madhya Pradesh',
      attribution: 'OSM',
    };
    deps.redis.get.mockResolvedValue(JSON.stringify(cached));
    global.fetch = jest.fn() as never;

    await expect(
      deps.service.reverseGeocode(22.7196, 75.8577),
    ).resolves.toEqual(cached);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('identifies the app, normalizes the response and caches it', async () => {
    const deps = buildDeps({
      NOMINATIM_USER_AGENT: 'Homingo/1.0 support@example.com',
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        display_name: 'Vijay Nagar, Indore, Madhya Pradesh, India',
        licence: 'Data © OpenStreetMap contributors',
        address: { city: 'Indore', state: 'Madhya Pradesh' },
      }),
    }) as never;

    const result = await deps.service.reverseGeocode(22.7196, 75.8577);

    expect(result.cityCandidates).toEqual(['Indore']);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'Homingo/1.0 support@example.com',
        }),
      }),
    );
    expect(deps.redis.set).toHaveBeenCalledWith(
      // Provider-scoped: switching adapters must not serve a result the other
      // one shaped, since the two format addressLine quite differently.
      'geo:reverse:nominatim:22.719600:75.857700',
      expect.any(String),
      2_592_000,
    );
  });

  it('fails clearly when Nominatim is not configured', async () => {
    const deps = buildDeps();
    await expect(deps.service.reverseGeocode(22.7, 75.8)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('does not exceed the shared provider request slot', async () => {
    const deps = buildDeps({ NOMINATIM_USER_AGENT: 'Homingo test' });
    deps.redis.setIfAbsent.mockResolvedValue(false);
    await expect(deps.service.reverseGeocode(22.7, 75.8)).rejects.toThrow(
      'Reverse geocoder is busy',
    );
  });
});
