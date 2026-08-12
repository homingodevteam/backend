/**
 * Module 10 · Reviews — the vocabularies and the rules that make the two
 * directions asymmetric.
 *
 * Ratings are asymmetric on purpose, and the asymmetry is the design rather
 * than an omission:
 *
 * | | Customer → Pro | Pro → Customer |
 * | -- | -- | -- |
 * | Comment  | free text, optional | **rejected** |
 * | Photos   | up to `review.maxPhotos` | none |
 * | Visible  | publicly | ops and the next Pro |
 * | Drives   | the dispatch tie-break, the public profile | nothing |
 *
 * Making the Pro direction drive dispatch would mean a household quietly
 * losing service with no explanation and no appeal, from a signal it cannot
 * see. Everything here is built so that cannot happen by accident.
 */

export const REVIEWER_TYPES = ['customer', 'pro'] as const;
export type ReviewerType = (typeof REVIEWER_TYPES)[number];

/**
 * What a customer may say about a Pro in one tap.
 *
 * A closed list rather than free strings. An unvalidated tag array is a
 * free-text field with extra steps: it cannot be counted, cannot be
 * translated, and turns into a thousand spellings of "late" the moment two
 * app versions are in the field.
 */
export const CUSTOMER_REVIEW_TAGS = [
  'punctual',
  'polite',
  'clean_work',
  'well_equipped',
  'explained_clearly',
  'late',
  'unprepared',
  'rushed',
] as const;
export type CustomerReviewTag = (typeof CUSTOMER_REVIEW_TAGS)[number];

/**
 * What a Pro may say about a household — feature 11's list, unchanged.
 *
 * Five tags and no sixth. Four of them are warnings the next Pro can act on
 * before they arrive; `pleasant` exists so the list is not purely a complaint
 * channel, which would make it one nobody trusts.
 */
export const PRO_REVIEW_TAGS = [
  'no_access',
  'unsafe',
  'pets_loose',
  'payment_difficulty',
  'pleasant',
] as const;
export type ProReviewTag = (typeof PRO_REVIEW_TAGS)[number];

export function tagsFor(reviewerType: ReviewerType): readonly string[] {
  return reviewerType === 'customer' ? CUSTOMER_REVIEW_TAGS : PRO_REVIEW_TAGS;
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

export const REVIEW_SETTINGS = {
  /**
   * How long after completion either party may still review. Past it both
   * directions close: a rating recalled a month later is about a memory, and
   * the Pro it lands on may have changed how they work twice since.
   */
  windowDays: { key: 'review.windowDays', fallback: 14 },
  /** Customer direction only. */
  maxPhotos: { key: 'review.maxPhotos', fallback: 3 },
} as const;

/** How many prior Pro notes the advisory shows before it is just noise. */
export const ADVISORY_RECENT_LIMIT = 5;

/**
 * A tag map with every tag in the vocabulary present, zero included.
 *
 * Zeroes matter to whoever reads this: `{ no_access: 3 }` alone leaves a
 * screen unable to tell "nobody reported it unsafe" from "this response
 * dropped the field".
 */
export function emptyTagCounts(
  reviewerType: ReviewerType,
): Record<string, number> {
  return Object.fromEntries(tagsFor(reviewerType).map((tag) => [tag, 0]));
}

/**
 * Tags as they came out of a `Json` column, narrowed and filtered to the
 * vocabulary.
 *
 * Anything unrecognised is dropped rather than surfaced. A tag written by an
 * app version that predates a vocabulary change should not reach a screen that
 * has no label for it.
 */
export function readTags(value: unknown, reviewerType: ReviewerType): string[] {
  if (!Array.isArray(value)) return [];
  const vocabulary = new Set<string>(tagsFor(reviewerType));
  return value.filter(
    (tag): tag is string => typeof tag === 'string' && vocabulary.has(tag),
  );
}

/** Photo keys as they came out of a `Json` column. */
export function readPhotoKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((key): key is string => typeof key === 'string');
}
