import { HttpException } from '@nestjs/common';
import {
  averageRating,
  evaluate,
  parseCriteria,
  type RatingCriteria,
} from './incentive-evaluators';

describe('parseCriteria', () => {
  it('accepts a well-formed job-count scheme', () => {
    expect(parseCriteria('jobs_count', { target: 50 })).toEqual({ target: 50 });
  });

  it('accepts a well-formed rating scheme', () => {
    expect(parseCriteria('rating', { minJobs: 20, minRating: 4.5 })).toEqual({
      minJobs: 20,
      minRating: 4.5,
    });
  });

  it.each([
    ['a missing target', 'jobs_count', {}],
    ['a zero target', 'jobs_count', { target: 0 }],
    ['a fractional target', 'jobs_count', { target: 12.5 }],
    ['a string target', 'jobs_count', { target: '50' }],
    ['a rating above five', 'rating', { minJobs: 5, minRating: 6 }],
    ['a rating below one', 'rating', { minJobs: 5, minRating: 0 }],
    ['a missing minJobs', 'rating', { minRating: 4.5 }],
    ['criteria that are not an object', 'jobs_count', 50],
    ['null criteria', 'rating', null],
  ] as const)('rejects %s at write time', (_label, type, json) => {
    expect(() => parseCriteria(type, json)).toThrow(HttpException);
  });

  /**
   * The two types nobody has written rules for. Configuring one must be
   * possible — the column accepts it — and must never look like it works.
   */
  it.each(['streak', 'surge_slot'] as const)(
    'returns null for %s rather than inventing a rule',
    (type) => {
      expect(parseCriteria(type, { anything: true })).toBeNull();
    },
  );
});

describe('evaluate', () => {
  describe('jobs_count', () => {
    const criteria = { target: 50 };

    it('is not achieved below the target', () => {
      expect(
        evaluate('jobs_count', criteria, {
          contributionCount: 49,
          progressValue: '49.00',
        }),
      ).toEqual({ targetValue: '50.00', achieved: false });
    });

    it('is achieved exactly on the target', () => {
      expect(
        evaluate('jobs_count', criteria, {
          contributionCount: 50,
          progressValue: '50.00',
        })?.achieved,
      ).toBe(true);
    });

    it('stays achieved above the target', () => {
      expect(
        evaluate('jobs_count', criteria, {
          contributionCount: 51,
          progressValue: '51.00',
        })?.achieved,
      ).toBe(true);
    });
  });

  describe('rating', () => {
    const criteria: RatingCriteria = { minJobs: 20, minRating: 4.5 };

    it('needs the minimum number of rated jobs, however good they are', () => {
      // 19 perfect jobs: a 5.0 average, still short of the volume gate.
      expect(
        evaluate('rating', criteria, {
          contributionCount: 19,
          progressValue: '95.00',
        })?.achieved,
      ).toBe(false);
    });

    it('needs the average as well as the volume', () => {
      // 20 jobs averaging 4.4.
      expect(
        evaluate('rating', criteria, {
          contributionCount: 20,
          progressValue: '88.00',
        })?.achieved,
      ).toBe(false);
    });

    it('is achieved sitting exactly on the threshold', () => {
      // 20 jobs, 90 stars, average exactly 4.5 — the case a float division
      // gets wrong often enough to matter.
      expect(
        evaluate('rating', criteria, {
          contributionCount: 20,
          progressValue: '90.00',
        }),
      ).toEqual({ targetValue: '90.00', achieved: true });
    });

    it('is achieved on a thirds average that does not divide cleanly', () => {
      // 21 jobs, 95 stars: 4.5238…, over the bar.
      expect(
        evaluate('rating', criteria, {
          contributionCount: 21,
          progressValue: '95.00',
        })?.achieved,
      ).toBe(true);

      // 21 jobs, 94 stars: 4.476…, under it.
      expect(
        evaluate('rating', criteria, {
          contributionCount: 21,
          progressValue: '94.00',
        })?.achieved,
      ).toBe(false);
    });

    it('is not achieved with nothing rated', () => {
      expect(
        evaluate('rating', criteria, {
          contributionCount: 0,
          progressValue: '0.00',
        })?.achieved,
      ).toBe(false);
    });
  });

  it.each(['streak', 'surge_slot'] as const)(
    'returns null for %s so the caller cannot mistake it for "not yet"',
    (type) => {
      expect(
        evaluate(type, null, { contributionCount: 999, progressValue: '999' }),
      ).toBeNull();
    },
  );
});

describe('averageRating', () => {
  it('is null before anything is rated', () => {
    expect(
      averageRating({ contributionCount: 0, progressValue: '0' }),
    ).toBeNull();
  });

  it('rounds to two decimals', () => {
    expect(
      averageRating({ contributionCount: 3, progressValue: '14.00' }),
    ).toBe('4.67');
  });
});
