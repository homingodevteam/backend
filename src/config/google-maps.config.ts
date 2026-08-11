type Env = Record<string, string | undefined>;

export interface GoogleMapsOptions {
  apiKey: string;
  baseUrl: string;
  /** Biases results toward a region — `in` for India. */
  region?: string;
  language: string;
  timeoutMs: number;
  cacheTtlSeconds: number;
}

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Returns `undefined` when no key is configured, rather than throwing.
 *
 * That is the same choice `buildRazorpayOptions` makes and for the same
 * reason: the absence of this key is a *deployment without Google*, not a
 * broken one. Reverse geocoding still works — the Nominatim adapter takes
 * over — so a developer with no billing account runs the whole product.
 *
 * The selection is by **presence**, not by a mode flag. A deployment that has
 * the key wants Google; one that does not cannot use it. An explicit
 * `GEOCODER_PROVIDER` still wins, for the case where someone has a key but
 * wants to test the free path.
 */
export function buildGoogleMapsOptions(
  env: Env = process.env,
): GoogleMapsOptions | undefined {
  const apiKey = str(env.GOOGLE_MAPS_API_KEY);
  if (!apiKey) return undefined;

  return {
    apiKey,
    baseUrl: str(env.GOOGLE_MAPS_BASE_URL) ?? 'https://maps.googleapis.com',
    region: str(env.GOOGLE_MAPS_REGION) ?? 'in',
    language: str(env.GOOGLE_MAPS_LANGUAGE) ?? 'en',
    timeoutMs: num(env.GOOGLE_MAPS_TIMEOUT_MS, 5000),
    // A pin's address does not change. Thirty days is the same window the
    // Nominatim adapter uses, and every cache hit is a request not billed.
    cacheTtlSeconds: num(env.GOOGLE_MAPS_CACHE_TTL_SECONDS, 2_592_000),
  };
}

export type GeocoderProviderName = 'nominatim' | 'google';

/**
 * Which adapter answers. Google when its key is present, unless overridden.
 */
export function resolveGeocoderProvider(
  env: Env = process.env,
): GeocoderProviderName {
  const configured = str(env.GEOCODER_PROVIDER)?.toLowerCase();

  if (configured !== undefined) {
    if (configured !== 'nominatim' && configured !== 'google') {
      throw new Error('GEOCODER_PROVIDER must be "nominatim" or "google".');
    }
    if (configured === 'google' && !str(env.GOOGLE_MAPS_API_KEY)) {
      throw new Error(
        'GEOCODER_PROVIDER=google needs GOOGLE_MAPS_API_KEY. Refusing to start ' +
          'rather than silently falling back to a different provider.',
      );
    }
    return configured;
  }

  return str(env.GOOGLE_MAPS_API_KEY) ? 'google' : 'nominatim';
}
