import type { ReverseGeocodeResult } from '../../geocoding/geocoding.types';

/**
 * Choosing what to call a grid cell, from what the geocoder said about its
 * centre.
 *
 * Pure and on its own so it can be tested against real provider payloads —
 * this is the function that decides whether an admin reviewing 500 cells sees
 * "Scheme 94" or "EW 105".
 *
 * ## Why it is not just the first line of the address
 *
 * It used to be. `addressLine.split(',')[0]` is correct for Nominatim, which
 * leads with the locality:
 *
 *     "Vijay Nagar, Indore, Madhya Pradesh, India"   ->  Vijay Nagar   ✓
 *
 * Google leads with the **building**, so the same slice names a service area
 * after somebody's house:
 *
 *     "EW 105, Scheme No. 94-E, ... Telephone Nagar, Indore, ..."  ->  EW 105    ✗
 *     "Pawar Villa, N-430, ... Talawali Chanda, Indore, ..."       ->  Pawar Villa ✗
 *     "121, Badi Bhamori, vijaynagar, Indore, ..."                 ->  121        ✗
 *
 * All three are real responses from this codebase's own key. The fix is to
 * read the provider's **structured** components rather than its display
 * string, which is what `localityCandidates` carries.
 */

/**
 * A Google **Plus Code**, which it leads the address line with wherever a pin
 * has no street address at all — which a rural grid cell's centre very often
 * does not:
 *
 *     "22HJ+7H Brahmankhedi, Madhya Pradesh, India"
 *     "WX4Q+P83, Madhya Pradesh, India"
 *
 * Drawn from a fixed 20-character alphabet, which is what keeps this from
 * eating a real name that happens to contain a '+'.
 */
const PLUS_CODE =
  /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/i;

/**
 * Rejected outright — these name a plot or a building, not a place.
 *
 * Every pattern below was added because a real Indore grid produced it. A
 * service area called "677/13" or "Shalimar Residency" is worse than one still
 * called "C3": the placeholder is visibly unreviewed, while a plausible-looking
 * wrong name gets approved at a glance and then routes bookings by it.
 */
const NOT_A_PLACE = [
  /^\d+$/, // "121"
  /^[A-Z]{1,3}[\s-]?\d+$/i, // "EW 105", "N-430", "B12"
  /^\d+[\s-]?[A-Z]{1,3}$/i, // "75-A" — the same thing written backwards
  /^\d+\s*\/\s*\d+/, // "677/13", "291/1" — khasra and survey numbers
  /^(plot|house|flat|shop|unit|block|gali|lane)\b/i,
  /^(no\.?|number)\s*\d/i,
  // A single building is not a service area. These are the suffixes Google
  // returns for one in an Indian city.
  /\b(residency|apartments?|towers?|duplex|villa|bungalow|plaza|arcade|complex|society|enclave|heights|greens|palms|county|countywalk)\b/i,
];

/**
 * Tidy a provider's string into something an admin would write.
 *
 * Google returns Indian locality names inconsistently cased — "vijaynagar"
 * alongside "Vijay Nagar" — and a list where the same place appears twice in
 * two casings is a list somebody has to clean by hand.
 */
export function tidyAreaName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';

  /**
   * Only re-case words that are uniformly one case, and leave short all-caps
   * words alone.
   *
   * "RAJWADA" is a shouted name and becomes "Rajwada". "MG" in "MG Road" is an
   * acronym and must not become "Mg" — so the all-caps rule applies from four
   * letters up, below which an acronym is the likelier reading. Anything
   * already mixed — "PU4", "Scheme 94-E" — was deliberate and survives
   * untouched.
   */
  return trimmed
    .split(' ')
    .map((word) => {
      const isAllLower = /^[a-z]+$/.test(word);
      const isLongAllCaps = /^[A-Z]{4,}$/.test(word);
      return isAllLower || isLongAllCaps
        ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        : word;
    })
    .join(' ');
}

function isPlausiblePlace(candidate: string): boolean {
  const value = candidate.trim();
  if (value.length < 3 || value.length > 80) return false;
  return !NOT_A_PLACE.some((pattern) => pattern.test(value));
}

/**
 * The best name for a cell, or `null` to leave its `A1` placeholder alone.
 *
 * Structured candidates first, in the order the provider ranks them. Falling
 * back to the address line only when the provider offered no locality at all —
 * a rural cell, usually — and even then every candidate has to survive
 * `isPlausiblePlace`, because "no name" is a better outcome for an admin
 * reviewing a list than a plot number that looks like a decision.
 */
export function pickAreaName(
  geocoded: ReverseGeocodeResult,
  cityName?: string,
): string | null {
  /**
   * The city's own name is the one plausible-looking answer that is always
   * wrong here. Google returns "Indore" for any cell it cannot resolve more
   * finely, so a grid ends up with "Indore", "Indore 2", "Indore 3" — names
   * that pass every other check and identify nothing inside Indore.
   */
  const isTheCityItself = (value: string): boolean =>
    cityName !== undefined &&
    value.trim().toLowerCase() === cityName.trim().toLowerCase();

  const usable = (value: string): boolean =>
    isPlausiblePlace(value) && !isTheCityItself(value);

  for (const candidate of geocoded.localityCandidates ?? []) {
    if (usable(candidate)) return tidyAreaName(candidate);
  }

  // Nominatim's shape, and the last resort for a Google result with no
  // sublocality of any kind. The Plus Code is stripped rather than rejected:
  // "22HJ+7H Brahmankhedi" still carries the village behind the code, and a
  // named cell beats a placeholder. When the code was the whole answer nothing
  // is left, and `isPlausiblePlace` refuses the empty string.
  const first = geocoded.addressLine
    ?.split(',')[0]
    ?.replace(PLUS_CODE, '')
    .trim();
  if (first && usable(first)) return tidyAreaName(first);

  return null;
}
