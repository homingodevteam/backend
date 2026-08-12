import {
  durationFit,
  finalRankScore,
  haversineKm,
  rotationScore,
  smoothedRating,
} from './dispatch.types';

describe('dispatch scoring maths', () => {
  describe('smoothed rating — the cold-start rule', () => {
    it('puts a Pro with no reviews exactly at the platform average', () => {
      // No grace flag, no expiry — the prior *is* the handling.
      expect(smoothedRating(0, 0, 4, 5)).toBe(4);
    });

    it('lets a 4.6 from many reviews beat a 5.0 from two', () => {
      const fiveFromTwo = smoothedRating(10, 2, 4, 5);
      const fourSixFromTwoHundred = smoothedRating(920, 200, 4, 5);

      // This is US-5.11's edge: it looks like a bug on an ops screen unless
      // both the raw and smoothed numbers are shown.
      expect(fourSixFromTwoHundred).toBeGreaterThan(fiveFromTwo);
    });

    it('pulls toward the truth as reviews accumulate', () => {
      const few = smoothedRating(25, 5, 4, 5);
      const many = smoothedRating(250, 50, 4, 5);
      expect(many).toBeGreaterThan(few);
      expect(many).toBeLessThanOrEqual(5);
    });
  });

  describe('rotation', () => {
    it('scores a Pro who never served this household at 1', () => {
      expect(rotationScore(0, 2)).toBe(1);
    });

    it('is a penalty, not an exclusion — never negative', () => {
      // A rotation-cooled Pro must still beat nobody at all.
      expect(rotationScore(99, 2)).toBe(0);
    });

    it('degrades with each recent job', () => {
      expect(rotationScore(1, 2)).toBeCloseTo(0.5);
    });
  });

  describe('duration fit', () => {
    it('is 1 when the job exactly fills the window', () => {
      const start = new Date('2026-08-14T09:00:00Z');
      const end = new Date('2026-08-14T10:00:00Z');
      expect(durationFit(60, { start, end })).toBe(1);
    });

    it('is lower when the window has slack', () => {
      const start = new Date('2026-08-14T09:00:00Z');
      const end = new Date('2026-08-14T13:00:00Z');
      expect(durationFit(60, { start, end })).toBeCloseTo(0.25);
    });

    it('is null with no window at all', () => {
      expect(durationFit(60, null)).toBeNull();
    });
  });

  describe('haversine', () => {
    it('is zero for the same point', () => {
      expect(haversineKm(22.7196, 75.8577, 22.7196, 75.8577)).toBe(0);
    });

    it('is symmetric', () => {
      const a = haversineKm(22.7196, 75.8577, 22.75, 75.9);
      const b = haversineKm(22.75, 75.9, 22.7196, 75.8577);
      expect(a).toBeCloseTo(b, 9);
    });
  });

  describe('finalRankScore', () => {
    const base = {
      travelTimeMinutes: 10,
      travelSoftTargetMinutes: 30,
      rotationScore: 1,
      durationFitScore: 1,
      ratingScore: 4,
      offersToday: 0,
    };

    it('prefers the nearer Pro, all else equal', () => {
      expect(finalRankScore({ ...base, travelTimeMinutes: 5 })).toBeGreaterThan(
        finalRankScore({ ...base, travelTimeMinutes: 40 }),
      );
    });

    it('prefers the Pro who has not served this household', () => {
      expect(finalRankScore(base)).toBeGreaterThan(
        finalRankScore({ ...base, rotationScore: 0 }),
      );
    });

    it('spreads load between otherwise identical Pros', () => {
      expect(finalRankScore(base)).toBeGreaterThan(
        finalRankScore({ ...base, offersToday: 5 }),
      );
    });

    it('lets proximity outweigh a rating gap', () => {
      // A Pro 40 minutes away is a worse customer outcome than a marginally
      // lower-rated one 5 minutes away.
      const nearLowerRated = finalRankScore({
        ...base,
        travelTimeMinutes: 5,
        ratingScore: 3.5,
      });
      const farTopRated = finalRankScore({
        ...base,
        travelTimeMinutes: 40,
        ratingScore: 5,
      });
      expect(nearLowerRated).toBeGreaterThan(farTopRated);
    });

    /**
     * The bug the decay curve exists to prevent. The old form was
     * `1 - travel / maxTravel` clamped at zero, which was harmless only while
     * anything past the cap was excluded outright. With the cap gone (#47)
     * that clamp would make every distant Pro tie at exactly 0 — so a
     * 70-minute Pro and a 200-minute one would rank the same, and rotation
     * would silently pick the winner.
     */
    it('still separates two Pros who are both far past the target', () => {
      const far = finalRankScore({ ...base, travelTimeMinutes: 70 });
      const further = finalRankScore({ ...base, travelTimeMinutes: 200 });

      expect(far).toBeGreaterThan(further);
      // Neither has bottomed out — the curve never reaches zero.
      expect(further).toBeGreaterThan(0);
    });

    it('keeps ordering by distance at any range', () => {
      const scores = [5, 20, 45, 90, 180, 400].map((travelTimeMinutes) =>
        finalRankScore({ ...base, travelTimeMinutes }),
      );

      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThan(scores[i - 1]);
      }
    });

    /**
     * The target is a scale, not a limit. Widening it does not admit anyone
     * new — nobody was being refused — it flattens the curve, so dispatch
     * weighs distance less against rating and rotation.
     */
    it('treats the soft target as a scale rather than a threshold', () => {
      const tight = finalRankScore({
        ...base,
        travelTimeMinutes: 60,
        travelSoftTargetMinutes: 15,
      });
      const relaxed = finalRankScore({
        ...base,
        travelTimeMinutes: 60,
        travelSoftTargetMinutes: 60,
      });

      expect(relaxed).toBeGreaterThan(tight);
      // Both still score — neither is excluded, which is the whole point.
      expect(tight).toBeGreaterThan(0);
    });

    it('never reads acceptanceRate — it is not even an input', () => {
      // Structural, not behavioural: ranking a Pro on acceptance rate would
      // punish them for undelivered pushes and provider outages.
      const inputs = Object.keys(base);
      expect(inputs).not.toContain('acceptanceRate');
      expect(finalRankScore.length).toBe(1);
    });
  });
});
