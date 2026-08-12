import type { GoogleRoutesOptions } from '../config/routing.config';
import { GoogleRouter } from './google.router';
import { HaversineRouter } from './haversine.router';

const OPTIONS: GoogleRoutesOptions = {
  apiKey: 'test-key',
  baseUrl: 'https://routes.example.test',
  region: 'in',
  timeoutMs: 4000,
  cacheTtlSeconds: 60,
  originPrecision: 3,
};

/** Indore: Rajwada, Vijay Nagar, and a job somewhere between them. */
const A = { lat: 22.7196, lng: 75.8577 };
const B = { lat: 22.7533, lng: 75.8937 };
const DEST = { lat: 22.74, lng: 75.87 };

function buildDeps() {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
  return { redis, store };
}

function build(deps: ReturnType<typeof buildDeps>): GoogleRouter {
  return new GoogleRouter(OPTIONS, deps.redis as never, new HaversineRouter());
}

/** A `computeRouteMatrix` reply. Order is the caller's to not depend on. */
function matrixReply(
  elements: {
    originIndex: number;
    seconds?: number;
    metres?: number;
    condition?: string;
  }[],
) {
  return {
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify(
          elements.map((element) => ({
            originIndex: element.originIndex,
            destinationIndex: 0,
            ...(element.seconds === undefined
              ? {}
              : { duration: `${element.seconds}s` }),
            ...(element.metres === undefined
              ? {}
              : { distanceMeters: element.metres }),
            condition: element.condition ?? 'ROUTE_EXISTS',
          })),
        ),
      ),
  } as unknown as Response;
}

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock;
});

describe('estimateMany', () => {
  it('returns a road estimate from the Routes API', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 660, metres: 4200 }]),
    );

    const [result] = await build(deps).estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(result).toEqual({
      minutes: 11,
      distanceMetres: 4200,
      source: 'google',
    });
  });

  it('rounds part-minutes up — nobody arrives early on a rounding artefact', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(matrixReply([{ originIndex: 0, seconds: 61 }]));

    const [result] = await build(deps).estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(result.minutes).toBe(2);
  });

  /**
   * The failure this class exists to prevent. Google returns elements
   * carrying `originIndex` in **no guaranteed order**; reading them as they
   * arrive gives one Pro another's travel time — a wrong dispatch ranking that
   * looks entirely plausible.
   */
  it('places results by originIndex, not by arrival order', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([
        { originIndex: 1, seconds: 1800 },
        { originIndex: 0, seconds: 300 },
      ]),
    );

    const results = await build(deps).estimateMany({
      origins: [A, B],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(results[0].minutes).toBe(5);
    expect(results[1].minutes).toBe(30);
  });

  it('falls back for one origin Google could not route, keeping the rest', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([
        { originIndex: 0, seconds: 300 },
        { originIndex: 1, condition: 'ROUTE_NOT_FOUND' },
      ]),
    );

    const results = await build(deps).estimateMany({
      origins: [A, B],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(results[0].source).toBe('google');
    // Still a number: a Pro must not drop out of the ranking because the road
    // graph is thin where they live.
    expect(results[1].source).toBe('haversine');
    expect(results[1].minutes).toBeGreaterThan(0);
  });

  it('falls back for every origin when the API errors', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"error":{"status":"PERMISSION_DENIED"}}'),
    });

    const results = await build(deps).estimateMany({
      origins: [A, B],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(results.map((r) => r.source)).toEqual(['haversine', 'haversine']);
  });

  it('falls back when the network is unreachable', async () => {
    const deps = buildDeps();
    fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));

    const results = await build(deps).estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(results[0].source).toBe('haversine');
  });

  it('asks for nothing when there are no origins', async () => {
    const deps = buildDeps();

    await expect(
      build(deps).estimateMany({
        origins: [],
        toLat: DEST.lat,
        toLng: DEST.lng,
        assumedSpeedKmph: 20,
      }),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a matrix larger than the cap rather than billing for it', async () => {
    const deps = buildDeps();
    const origins = Array.from({ length: 51 }, (_, i) => ({
      lat: 22.7 + i / 1000,
      lng: 75.8,
    }));

    const results = await build(deps).estimateMany({
      origins,
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(results).toHaveLength(51);
    expect(results.every((r) => r.source === 'haversine')).toBe(true);
  });

  it('sends one call for many origins, not one per origin', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([
        { originIndex: 0, seconds: 300 },
        { originIndex: 1, seconds: 600 },
      ]),
    );

    await build(deps).estimateMany({
      origins: [A, B],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for a traffic-aware drive and only the fields it uses', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 300 }]),
    );

    await build(deps).estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/distanceMatrix/v2:computeRouteMatrix');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('test-key');
    // The field mask is also the bill — asking for a polyline here would
    // multiply the cost for data nothing renders.
    expect(headers['X-Goog-FieldMask']).not.toContain('polyline');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.travelMode).toBe('DRIVE');
    expect(body.routingPreference).toBe('TRAFFIC_AWARE');
  });
});

describe('caching', () => {
  it('serves a repeat of the same origin from cache', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 300 }]),
    );
    const router = build(deps);

    const first = await router.estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });
    const second = await router.estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second[0]).toEqual(first[0]);
  });

  /**
   * The cost control. A Pro's phone reports every few seconds; without
   * rounding, every fix is a distinct key and every ping is a billed call.
   * Three decimals is about 110 m — less than a block.
   */
  it('treats a metre of movement as the same origin', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 300 }]),
    );
    const router = build(deps);

    await router.estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });
    await router.estimateMany({
      origins: [{ lat: A.lat + 0.00002, lng: A.lng + 0.00002 }],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a genuine move as a new origin', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 300 }]),
    );
    const router = build(deps);

    await router.estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });
    await router.estimateMany({
      origins: [B],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keys on the destination too', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 300 }]),
    );
    const router = build(deps);

    await router.estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });
    await router.estimateMany({
      origins: [A],
      toLat: B.lat,
      toLng: B.lng,
      assumedSpeedKmph: 20,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('only asks Google about the origins it has not cached', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 300 }]),
    );
    const router = build(deps);

    await router.estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 900 }]),
    );
    const results = await router.estimateMany({
      origins: [A, B],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    // Second call asked about B only — one origin, not two.
    const body = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    ) as { origins: unknown[] };
    expect(body.origins).toHaveLength(1);

    expect(results[0].minutes).toBe(5); // A, from cache
    expect(results[1].minutes).toBe(15); // B, fresh
  });

  it('still answers when the cache is down', async () => {
    const deps = buildDeps();
    deps.redis.get.mockRejectedValue(new Error('redis down'));
    deps.redis.set.mockRejectedValue(new Error('redis down'));
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 300 }]),
    );

    const [result] = await build(deps).estimateMany({
      origins: [A],
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(result.minutes).toBe(5);
  });
});

describe('estimate', () => {
  it('is the one-origin case of the matrix', async () => {
    const deps = buildDeps();
    fetchMock.mockResolvedValue(
      matrixReply([{ originIndex: 0, seconds: 420 }]),
    );

    const result = await build(deps).estimate({
      fromLat: A.lat,
      fromLng: A.lng,
      toLat: DEST.lat,
      toLng: DEST.lng,
      assumedSpeedKmph: 20,
    });

    expect(result).toEqual({
      minutes: 7,
      distanceMetres: null,
      source: 'google',
    });
  });
});
