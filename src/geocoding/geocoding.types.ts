export const GEOCODER = Symbol('GEOCODER');

export interface ReverseGeocodeResult {
  /** Human-readable, as the provider formats it. */
  addressLine: string;
  /** Every name the provider offers for the settlement, best first. */
  cityCandidates: string[];
  /**
   * Neighbourhood-level names, best first — the layer between a street and a
   * city. "Vijay Nagar", "Scheme 94", "Telephone Nagar".
   *
   * Structured, not sliced off the front of `addressLine`. That distinction is
   * the whole reason this field exists: Nominatim leads its address line with
   * the locality, so splitting on the first comma worked; Google leads with the
   * **building** — "EW 105", "Pawar Villa", "121" — so the same slice names a
   * cell after somebody's house. See CONFLICTS_AND_DECISIONS #59.
   *
   * Empty when the provider offers nothing at this level, which is honest: a
   * pin in farmland has no neighbourhood.
   */
  localityCandidates: string[];
  stateName: string | null;
  postalCode: string | null;
  /** Which provider answered — `nominatim` or `google`. */
  provider: string;
  /**
   * Required by both providers' terms and shown wherever the address is.
   * Google's licence obliges display; OpenStreetMap's ODbL obliges credit.
   */
  attribution: string;
}

/**
 * Turning a pin into words.
 *
 * Two implementations, chosen by which credentials are present — the same
 * shape as the OTP provider, where Slide takes over from the mock the moment
 * its keys exist. Nothing that consumes this knows which one answered, beyond
 * the `provider` field it can log.
 */
/** A city's own extent, as the provider draws it. */
export interface CityBounds {
  /** What the provider matched, so an admin can see it took the right place. */
  matchedName: string;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  /** Rough size, for a human sanity-check before it becomes 900 cells. */
  widthKm: number;
  heightKm: number;
  provider: string;
  attribution: string;
}

export interface GeocoderPort {
  reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult>;

  /**
   * A city name to the box it occupies — the forward direction.
   *
   * Exists so opening a city does not start with somebody guessing how many
   * kilometres across it is. Google returns Indore as 24.6 x 20.1 km, which is
   * the city proper rather than the district; a guessed 30 km square covers
   * half again as much farmland.
   *
   * A **rectangle**, not a radius, because cities are not square and the
   * difference is real: 20 km east-west against 25 north-south is a fifth of
   * the generated cells saved before anybody deactivates anything.
   */
  geocodeCity(name: string): Promise<CityBounds>;

  /**
   * How long a caller must wait between requests.
   *
   * Not a detail a caller should have to know per provider, which is exactly
   * why it is on the interface. OpenStreetMap's public Nominatim permits **one
   * request per second for an entire application**, so a 36-cell naming pass
   * takes over half a minute; Google's is a paid quota with no politeness
   * interval, so the same pass finishes in seconds.
   *
   * `AreaNamingService` reads this rather than hard-coding a delay, so adding
   * a Google key makes the naming pass roughly thirty times faster without a
   * line changing there.
   */
  readonly minIntervalMs: number;
}

/** Mean km per degree of latitude. Longitude narrows toward the poles. */
const KM_PER_DEGREE_LAT = 111.32;

/**
 * Rough size of a bounding box, for a human to sanity-check.
 *
 * Not used for anything the grid depends on — `generateGrid` does its own
 * exact arithmetic. This is so an admin sees "24.6 x 20.1 km" before agreeing
 * to something that becomes 500 rows.
 */
export function boundsSizeKm(box: {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}): { widthKm: number; heightKm: number } {
  const midLat = (box.minLat + box.maxLat) / 2;
  const kmPerDegLng = KM_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180);

  return {
    heightKm: Number(
      ((box.maxLat - box.minLat) * KM_PER_DEGREE_LAT).toFixed(1),
    ),
    widthKm: Number(((box.maxLng - box.minLng) * kmPerDegLng).toFixed(1)),
  };
}
