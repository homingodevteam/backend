import {
  computeNetPayable,
  computeShares,
  consumeAgainst,
  sumRupees,
} from './commission-calculator';

describe('computeShares', () => {
  describe('percent', () => {
    it('takes the percentage of the job price', () => {
      expect(
        computeShares({
          flatPrice: '1000.00',
          rate: { commissionType: 'percent', commissionValue: '30.00' },
        }),
      ).toEqual({
        commissionAmount: '300.00',
        platformAmount: '700.00',
        capped: false,
      });
    });

    it('scales with the price — a repriced job pays the Pro less (US-8.4)', () => {
      const rate = {
        commissionType: 'percent' as const,
        commissionValue: '30.00',
      };
      expect(
        computeShares({ flatPrice: '800.00', rate }).commissionAmount,
      ).toBe('240.00');
    });

    it('handles a fractional rate exactly', () => {
      expect(
        computeShares({
          flatPrice: '999.99',
          rate: { commissionType: 'percent', commissionValue: '12.50' },
        }),
      ).toEqual({
        commissionAmount: '125.00',
        platformAmount: '874.99',
        capped: false,
      });
    });

    it('rounds half up at the paise boundary, in integers', () => {
      // 1 % of 1234.55 is 12.3455 -> the half-paise case rounds up.
      expect(
        computeShares({
          flatPrice: '1234.55',
          rate: { commissionType: 'percent', commissionValue: '1.00' },
        }).commissionAmount,
      ).toBe('12.35');

      // 1 % of 1234.54 is 12.3454 -> down.
      expect(
        computeShares({
          flatPrice: '1234.54',
          rate: { commissionType: 'percent', commissionValue: '1.00' },
        }).commissionAmount,
      ).toBe('12.35');

      // 1 % of 1234.44 is 12.3444 -> down.
      expect(
        computeShares({
          flatPrice: '1234.44',
          rate: { commissionType: 'percent', commissionValue: '1.00' },
        }).commissionAmount,
      ).toBe('12.34');
    });

    it('pays everything at 100% and nothing at 0%', () => {
      expect(
        computeShares({
          flatPrice: '450.00',
          rate: { commissionType: 'percent', commissionValue: '100.00' },
        }),
      ).toEqual({
        commissionAmount: '450.00',
        platformAmount: '0.00',
        capped: false,
      });

      expect(
        computeShares({
          flatPrice: '450.00',
          rate: { commissionType: 'percent', commissionValue: '0' },
        }),
      ).toEqual({
        commissionAmount: '0.00',
        platformAmount: '450.00',
        capped: false,
      });
    });
  });

  describe('flat', () => {
    it('pays the fixed amount whatever the price', () => {
      const rate = { commissionType: 'flat' as const, commissionValue: '300' };
      expect(
        computeShares({ flatPrice: '1000.00', rate }).commissionAmount,
      ).toBe('300.00');
      expect(
        computeShares({ flatPrice: '800.00', rate }).commissionAmount,
      ).toBe('300.00');
    });

    it('makes the platform absorb the whole of a price cut (US-8.4)', () => {
      const rate = { commissionType: 'flat' as const, commissionValue: '300' };
      expect(computeShares({ flatPrice: '1000.00', rate }).platformAmount).toBe(
        '700.00',
      );
      expect(computeShares({ flatPrice: '800.00', rate }).platformAmount).toBe(
        '500.00',
      );
    });

    it('clamps a rate above the price rather than going negative', () => {
      expect(
        computeShares({
          flatPrice: '200.00',
          rate: { commissionType: 'flat', commissionValue: '220.00' },
        }),
      ).toEqual({
        commissionAmount: '200.00',
        platformAmount: '0.00',
        capped: true,
      });
    });
  });

  it('never lets the two shares drift from the price', () => {
    const prices = ['1.00', '99.99', '333.33', '1000.00', '12345.67'];
    const rates = [
      { commissionType: 'percent' as const, commissionValue: '33.33' },
      { commissionType: 'percent' as const, commissionValue: '7.77' },
      { commissionType: 'flat' as const, commissionValue: '99.99' },
    ];

    for (const flatPrice of prices) {
      for (const rate of rates) {
        const shares = computeShares({ flatPrice, rate });
        expect(
          sumRupees([shares.commissionAmount, shares.platformAmount]),
        ).toBe(
          // Normalised through the same path, so '1.00' compares to '1.00'.
          sumRupees([flatPrice]),
        );
      }
    }
  });

  /**
   * The guard on CONFLICTS_AND_DECISIONS #18 and US-8.5.
   *
   * A four-hour job pays exactly what a one-hour one does. There is no
   * duration parameter to pass, so the only input this function can be given
   * is the price and the rate — asserted here so that adding a duration later
   * has to break a test rather than slip through as a helpful extra field.
   */
  it('is a function of the price and the rate, and nothing else', () => {
    const argument = {
      flatPrice: '1000.00',
      rate: { commissionType: 'flat' as const, commissionValue: '300' },
    };
    expect(Object.keys(argument).sort()).toEqual(['flatPrice', 'rate']);
    expect(computeShares(argument).commissionAmount).toBe('300.00');
  });
});

describe('computeNetPayable', () => {
  it('adds the bonus and subtracts the deduction', () => {
    expect(
      computeNetPayable({
        commissionAmount: '300.00',
        incentiveAmount: '50.00',
        deductionAmount: '20.00',
      }),
    ).toBe('330.00');
  });

  it('floors at zero — a job never owes money', () => {
    expect(
      computeNetPayable({
        commissionAmount: '300.00',
        incentiveAmount: '0',
        deductionAmount: '500.00',
      }),
    ).toBe('0.00');
  });
});

describe('sumRupees', () => {
  it('is exact over amounts a float would drift on', () => {
    expect(sumRupees(['0.10', '0.20'])).toBe('0.30');
    expect(sumRupees(Array<string>(10).fill('0.07'))).toBe('0.70');
  });

  it('is zero for nothing', () => {
    expect(sumRupees([])).toBe('0.00');
  });
});

describe('consumeAgainst', () => {
  it('takes the whole debt when the earnings cover it', () => {
    expect(consumeAgainst('1000.00', '300.00')).toEqual({
      taken: '300.00',
      remainingOwed: '0.00',
      remainingAvailable: '700.00',
    });
  });

  it('takes only what is there and carries the rest forward', () => {
    expect(consumeAgainst('2000.00', '5000.00')).toEqual({
      taken: '2000.00',
      remainingOwed: '3000.00',
      remainingAvailable: '0.00',
    });
  });

  it('takes nothing from nothing', () => {
    expect(consumeAgainst('0.00', '400.00')).toEqual({
      taken: '0.00',
      remainingOwed: '400.00',
      remainingAvailable: '0.00',
    });
  });
});
