import { payoutPeriod, periodFor, startOfIstDay } from './incentive-periods';

/** 12 Aug 2026, 14:30 IST. */
const AFTERNOON = new Date('2026-08-12T09:00:00.000Z');

describe('periodFor', () => {
  it('gives every job the same period for a one-shot scheme', () => {
    const a = periodFor('once', AFTERNOON);
    const b = periodFor('once', new Date('2031-01-01T00:00:00.000Z'));
    expect(a.key).toBe('lifetime');
    expect(b.key).toBe('lifetime');
  });

  it('keys a monthly scheme by the Indian month', () => {
    const period = periodFor('monthly', AFTERNOON);
    expect(period.key).toBe('2026-08');
    // 1 Aug 00:00 IST is 31 Jul 18:30 UTC.
    expect(period.start.toISOString()).toBe('2026-07-31T18:30:00.000Z');
    expect(period.end.toISOString()).toBe('2026-08-31T18:30:00.000Z');
  });

  /**
   * The reason the whole file is IST rather than UTC. This instant is
   * 01:00 on 1 September in Indore and 19:30 on 31 August in UTC; filing it
   * under August would hand the Pro a job in a month they did not work it.
   */
  it('files a job just after Indian midnight into the new month', () => {
    const justAfterIstMidnight = new Date('2026-08-31T19:30:00.000Z');
    expect(periodFor('monthly', justAfterIstMidnight).key).toBe('2026-09');
  });

  it('files a job just before Indian midnight into the old month', () => {
    const justBeforeIstMidnight = new Date('2026-08-31T18:29:00.000Z');
    expect(periodFor('monthly', justBeforeIstMidnight).key).toBe('2026-08');
  });

  it('rolls a December monthly period into January', () => {
    const period = periodFor('monthly', new Date('2026-12-15T06:00:00.000Z'));
    expect(period.key).toBe('2026-12');
    expect(period.end.toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });

  it('keys a daily scheme by the Indian date', () => {
    const period = periodFor('daily', AFTERNOON);
    expect(period.key).toBe('2026-08-12');
    expect(period.start.toISOString()).toBe('2026-08-11T18:30:00.000Z');
    expect(period.end.toISOString()).toBe('2026-08-12T18:30:00.000Z');
  });

  describe('weekly', () => {
    it('runs Monday to Sunday', () => {
      // 12 Aug 2026 is a Wednesday; its week starts Monday the 10th.
      const period = periodFor('weekly', AFTERNOON);
      expect(period.start.toISOString()).toBe('2026-08-09T18:30:00.000Z');
      expect(period.end.toISOString()).toBe('2026-08-16T18:30:00.000Z');
    });

    it('gives every day of one week the same key', () => {
      const monday = periodFor('weekly', new Date('2026-08-10T06:00:00.000Z'));
      const sunday = periodFor('weekly', new Date('2026-08-16T06:00:00.000Z'));
      expect(monday.key).toBe(sunday.key);
      expect(monday.key).toBe('2026-W33');
    });

    it('starts a new key on the next Monday', () => {
      const sunday = periodFor('weekly', new Date('2026-08-16T06:00:00.000Z'));
      const monday = periodFor('weekly', new Date('2026-08-17T06:00:00.000Z'));
      expect(monday.key).not.toBe(sunday.key);
      expect(monday.key).toBe('2026-W34');
    });

    /**
     * An ISO week belongs to whichever year holds its Thursday. Without that
     * rule a new-year job lands in a fresh week key and the same weekly bonus
     * can be won twice in eight days.
     */
    it('keeps a new-year week with the year that holds its Thursday', () => {
      // 1 Jan 2027 is a Friday, so it sits in the last week of 2026.
      expect(
        periodFor('weekly', new Date('2027-01-01T06:00:00.000Z')).key,
      ).toBe('2026-W53');
    });
  });
});

describe('payoutPeriod', () => {
  it('spans the requested number of Indian days, ending inclusive', () => {
    const { start, end } = payoutPeriod(
      new Date('2026-08-31T09:00:00.000Z'),
      30,
    );
    // 30 days ending 31 Aug -> starts 2 Aug 00:00 IST.
    expect(start.toISOString()).toBe('2026-08-01T18:30:00.000Z');
    // Exclusive upper bound: midnight IST at the start of 1 Sep.
    expect(end.toISOString()).toBe('2026-08-31T18:30:00.000Z');
  });

  it('handles a single-day period', () => {
    const { start, end } = payoutPeriod(
      new Date('2026-08-12T09:00:00.000Z'),
      1,
    );
    expect(start.toISOString()).toBe('2026-08-11T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-08-12T18:30:00.000Z');
  });
});

describe('startOfIstDay', () => {
  it('is Indian midnight, not UTC midnight', () => {
    expect(startOfIstDay(AFTERNOON).toISOString()).toBe(
      '2026-08-11T18:30:00.000Z',
    );
  });

  it('treats 20:00 UTC as already tomorrow in India', () => {
    expect(
      startOfIstDay(new Date('2026-08-12T20:00:00.000Z')).toISOString(),
    ).toBe('2026-08-12T18:30:00.000Z');
  });
});
