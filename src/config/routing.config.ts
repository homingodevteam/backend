type Env = Record<string, string | undefined>;

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface GoogleRoutesOptions {
  apiKey: string;
  baseUrl: string;
  region?: string;
  timeoutMs: number;
  /**
   * How long a road estimate stays usable.
   *
   * Short, unlike the 30-day geocode cache, and for the opposite reason: an
   * address at a pin does not change, and traffic on a road changes constantly.
   * Sixty seconds is the balance between a stale ETA and a request per GPS
   * ping — a Pro's phone reports every few seconds, so without this the live
   * map alone would bill thousands of calls an hour per active job.
   */
  cacheTtlSeconds: number;
  /**
   * Decimal places an origin is rounded to before it becomes a cache key.
   *
   * Three is about 110 m. A Pro who has moved less than a block has not
   * meaningfully changed their ETA, and rounding is what turns a stream of
   * distinct GPS fixes into repeated cache hits.
   */
  originPrecision: number;
}

/**
 * The Routes API is **not** the Geocoding API.
 *
 * Different host (`routes.googleapis.com`), different product, and a
 * separately enabled API in the Google console — a key that geocodes happily
 * will return `PERMISSION_DENIED` here until Routes is switched on for the
 * project.
 *
 * It also replaces the legacy Distance Matrix and Directions APIs, which is
 * why this targets it directly: Google marked those legacy in 2025 and new
 * projects cannot enable them at all, so building against Distance Matrix
 * would have produced code that works on old keys and fails on new ones.
 *
 * By default the same `GOOGLE_MAPS_API_KEY` serves both. `GOOGLE_ROUTES_API_KEY`
 * overrides it, for a deployment that wants routing on a separate key with its
 * own quota and its own bill.
 */
export function buildGoogleRoutesOptions(
  env: Env = process.env,
): GoogleRoutesOptions | undefined {
  const apiKey = str(env.GOOGLE_ROUTES_API_KEY) ?? str(env.GOOGLE_MAPS_API_KEY);
  if (!apiKey) return undefined;

  return {
    apiKey,
    baseUrl: str(env.GOOGLE_ROUTES_BASE_URL) ?? 'https://routes.googleapis.com',
    region: str(env.GOOGLE_MAPS_REGION) ?? 'in',
    timeoutMs: num(env.ROUTING_TIMEOUT_MS, 4000),
    cacheTtlSeconds: num(env.ROUTING_CACHE_TTL_SECONDS, 60),
    originPrecision: num(env.ROUTING_ORIGIN_PRECISION, 3),
  };
}

export type RouterProviderName = 'haversine' | 'google';

/**
 * Which router answers. Google when a key is present, unless overridden.
 *
 * The same presence rule as the geocoder, and one deliberate difference in
 * consequence: a deployment with no key still gets working dispatch ranking
 * from straight lines. What it does not get is a customer-facing ETA, because
 * a crow-flight guess published as an arrival time is worse than no number.
 */
export function resolveRouterProvider(
  env: Env = process.env,
): RouterProviderName {
  const configured = str(env.ROUTING_PROVIDER)?.toLowerCase();

  if (configured !== undefined) {
    if (configured !== 'haversine' && configured !== 'google') {
      throw new Error('ROUTING_PROVIDER must be "haversine" or "google".');
    }
    if (
      configured === 'google' &&
      !str(env.GOOGLE_ROUTES_API_KEY) &&
      !str(env.GOOGLE_MAPS_API_KEY)
    ) {
      throw new Error(
        'ROUTING_PROVIDER=google needs GOOGLE_ROUTES_API_KEY or ' +
          'GOOGLE_MAPS_API_KEY. Refusing to start rather than silently ' +
          'falling back to straight-line estimates.',
      );
    }
    return configured;
  }

  return (str(env.GOOGLE_ROUTES_API_KEY) ?? str(env.GOOGLE_MAPS_API_KEY))
    ? 'google'
    : 'haversine';
}
