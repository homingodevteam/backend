import type { ReverseGeocodeResult } from '../../geocoding/geocoding.types';
import { pickAreaName, tidyAreaName } from './area-name';

function geocoded(
  overrides: Partial<ReverseGeocodeResult> = {},
): ReverseGeocodeResult {
  return {
    addressLine: '',
    cityCandidates: ['Indore'],
    localityCandidates: [],
    stateName: 'Madhya Pradesh',
    postalCode: null,
    provider: 'google',
    attribution: 'Map data ©2026 Google',
    ...overrides,
  };
}

describe('pickAreaName', () => {
  it('takes the structured locality ahead of the address line', () => {
    expect(
      pickAreaName(
        geocoded({
          localityCandidates: ['Scheme 94', 'Indore'],
          addressLine: 'EW 105, Scheme No. 94-E, Indore, MP, India',
        }),
      ),
    ).toBe('Scheme 94');
  });

  /**
   * The three real responses from this codebase's own key that exposed the
   * bug. Every one of them named a cell after a building under the old
   * first-comma rule.
   */
  describe('real Google payloads that used to name a cell after a building', () => {
    it('does not call a cell "EW 105"', () => {
      const name = pickAreaName(
        geocoded({
          localityCandidates: ['Telephone Nagar', 'Indore'],
          addressLine:
            'EW 105, Schema No. 94 Scheme No. 94-E, EW59, Telephone Nagar, Indore, Madhya Pradesh 452018, India',
        }),
      );
      expect(name).toBe('Telephone Nagar');
      expect(name).not.toBe('EW 105');
    });

    it('does not call a cell "Pawar Villa"', () => {
      expect(
        pickAreaName(
          geocoded({
            localityCandidates: ['Talawali Chanda'],
            addressLine:
              'Pawar Villa, N-430, Singapore Green View, Talawali Chanda, Indore, Madhya Pradesh 452007, India',
          }),
        ),
      ).toBe('Talawali Chanda');
    });

    it('does not call a cell "121"', () => {
      expect(
        pickAreaName(
          geocoded({
            localityCandidates: ['Badi Bhamori'],
            addressLine:
              '121, Badi Bhamori, vijaynagar, Indore, Madhya Pradesh 452010, India',
          }),
        ),
      ).toBe('Badi Bhamori');
    });
  });

  /** Nominatim leads with the locality, so the old path still has to work. */
  it('falls back to the address line when no structured locality is offered', () => {
    expect(
      pickAreaName(
        geocoded({
          provider: 'nominatim',
          localityCandidates: [],
          addressLine: 'Vijay Nagar, Indore, Madhya Pradesh, India',
        }),
      ),
    ).toBe('Vijay Nagar');
  });

  it('skips a plot-shaped candidate and takes the next real one', () => {
    expect(
      pickAreaName(geocoded({ localityCandidates: ['B-12', 'Sudama Nagar'] })),
    ).toBe('Sudama Nagar');
  });

  /**
   * `null` leaves the `A1` placeholder. For an admin reviewing 500 cells that
   * is a better outcome than a plot number, which reads as a decision somebody
   * made.
   */
  it.each([
    ['a bare number', '121'],
    ['a plot code', 'EW 105'],
    ['a hyphenated plot', 'N-430'],
    ['an explicit plot', 'Plot 14'],
    ['a house number', 'No. 22'],
    ['something too short', 'A'],
  ])('returns null rather than naming a cell after %s', (_label, value) => {
    expect(
      pickAreaName(
        geocoded({ localityCandidates: [value], addressLine: value }),
      ),
    ).toBeNull();
  });

  it('returns null when the provider offered nothing at all', () => {
    expect(pickAreaName(geocoded({ addressLine: '' }))).toBeNull();
  });
});

describe('tidyAreaName', () => {
  /**
   * Google returns Indian locality names inconsistently cased — "vijaynagar"
   * beside "Vijay Nagar" — and a review list with the same place twice in two
   * casings is a list somebody cleans by hand.
   */
  it('title-cases an all-lowercase name', () => {
    expect(tidyAreaName('vijaynagar')).toBe('Vijaynagar');
    expect(tidyAreaName('sudama nagar')).toBe('Sudama Nagar');
  });

  it('calms an all-caps name down', () => {
    expect(tidyAreaName('RAJWADA')).toBe('Rajwada');
  });

  /** Mixed case was deliberate. "MG Road" must not become "Mg Road". */
  it('leaves a deliberately mixed-case name alone', () => {
    expect(tidyAreaName('MG Road')).toBe('MG Road');
    expect(tidyAreaName('PU4 Scheme')).toBe('PU4 Scheme');
  });

  it('collapses stray whitespace', () => {
    expect(tidyAreaName('  Vijay   Nagar  ')).toBe('Vijay Nagar');
  });
});
