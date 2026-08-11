import {
  fromPaise,
  rupeesDifference,
  rupeesEqual,
  toPaise,
} from './payments.money';

describe('toPaise', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
    ['1.05', 105],
    ['1234.56', 123456],
    ['0.01', 1],
    ['0.10', 10],
    // The largest value Decimal(12,2) holds.
    ['9999999999.99', 999999999999],
  ])('converts %s to %i paise', (rupees, expected) => {
    expect(toPaise(rupees)).toBe(expected);
  });

  /**
   * The reason this module exists.
   *
   * `16.08 * 100` is 1607.9999999999998 in IEEE 754 and `1.005 * 100` is
   * 100.49999999999999 — so naive truncation loses a paisa, and `Math.round`
   * rescues the first while getting the second wrong in the other direction
   * (it yields 100, when ₹1.005 is not a representable price at all and must
   * be refused). Going through the decimal string means the float is never an
   * operand.
   */
  it.each([
    ['16.08', 1608],
    ['1.13', 113],
    ['0.29', 29],
  ])(
    'converts %s exactly, where float arithmetic does not',
    (rupees, expected) => {
      expect(toPaise(rupees)).toBe(expected);
      expect(Number(rupees) * 100).not.toBe(expected);
    },
  );

  it('refuses a third decimal place rather than rounding it', () => {
    expect(() => toPaise('1.005')).toThrow(/rupee amount/);
  });

  it('accepts a Decimal column value, which arrives as a string', () => {
    expect(toPaise('499.00')).toBe(49900);
  });

  it.each(['', 'abc', '1.234', '-5', '1,234.00', '1e3', ' '])(
    'refuses %p rather than sending a wrong amount to the gateway',
    (bad) => {
      expect(() => toPaise(bad)).toThrow(/rupee amount/);
    },
  );
});

describe('fromPaise', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [10, '0.10'],
    [100, '1.00'],
    [123456, '1234.56'],
  ])('converts %i paise to %s', (paise, expected) => {
    expect(fromPaise(paise)).toBe(expected);
  });

  it('always gives two decimal places, so it can be compared to a Decimal', () => {
    expect(fromPaise(50000)).toBe('500.00');
  });

  it('handles a negative difference, which variance reporting produces', () => {
    expect(fromPaise(-2550)).toBe('-25.50');
  });

  it('refuses a fractional paisa — there is no such unit', () => {
    expect(() => fromPaise(100.5)).toThrow(/whole number/);
  });

  it('round-trips every value toPaise accepts', () => {
    for (const rupees of ['0.00', '0.01', '99.99', '1234.56', '10000.00']) {
      expect(fromPaise(toPaise(rupees))).toBe(rupees);
    }
  });
});

describe('rupeesEqual', () => {
  it('treats trailing zeros as the same amount', () => {
    expect(rupeesEqual('100', '100.00')).toBe(true);
    expect(rupeesEqual('100.5', '100.50')).toBe(true);
  });

  it('is exact — a paisa apart is not equal', () => {
    expect(rupeesEqual('100.00', '100.01')).toBe(false);
  });
});

describe('rupeesDifference', () => {
  it('reports a shortfall as a negative amount', () => {
    expect(rupeesDifference('900.00', '1000.00')).toBe('-100.00');
  });

  it('reports an overcharge as a positive amount', () => {
    expect(rupeesDifference('1000.00', '900.50')).toBe('99.50');
  });

  it('reports nothing when the gateway agrees with us', () => {
    expect(rupeesDifference('499.00', '499')).toBe('0.00');
  });
});
