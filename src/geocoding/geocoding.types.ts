export const GEOCODER = Symbol('GEOCODER');

export interface ReverseGeocodeResult {
  /** Human-readable, as the provider formats it. */
  addressLine: string;
  /** Every name the provider offers for the settlement, best first. */
  cityCandidates: string[];
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
export interface GeocoderPort {
  reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult>;

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
