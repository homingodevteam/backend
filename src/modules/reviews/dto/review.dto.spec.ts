import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../../config/validation.config';
import { CreateCustomerReviewDto, CreateProReviewDto } from './review.dto';

/**
 * The asymmetry between the two directions, enforced at the edge of the API
 * rather than only in the service.
 *
 * Every case runs through `VALIDATION_PIPE_OPTIONS` — the same object
 * `main.ts` hands the global pipe — because a test proving rejection under
 * different options proves nothing about the running application.
 */
function failingFields(cls: new () => object, payload: unknown): string[] {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  return validateSync(dto, VALIDATION_PIPE_OPTIONS)
    .map((error) => error.property)
    .sort();
}

describe('CreateProReviewDto', () => {
  /**
   * The asymmetry, enforced at the edge. A Pro who typed a paragraph about a
   * household should be told it was not stored, not left believing ops will
   * read it — so this is a 400 rather than a silently dropped field.
   */
  it('rejects a comment outright', () => {
    expect(
      failingFields(CreateProReviewDto, {
        rating: 2,
        comment: 'this household is difficult',
      }),
    ).toEqual(['comment']);
  });

  it('rejects a tag outside the vocabulary', () => {
    expect(
      failingFields(CreateProReviewDto, { rating: 2, tags: ['rude'] }),
    ).toEqual(['tags']);
  });

  it('accepts the vocabulary it does have', () => {
    expect(
      failingFields(CreateProReviewDto, {
        rating: 2,
        tags: ['no_access', 'pets_loose'],
      }),
    ).toEqual([]);
  });
});

describe('CreateCustomerReviewDto', () => {
  it('accepts a rating on its own — comment and tags are optional', () => {
    expect(failingFields(CreateCustomerReviewDto, { rating: 5 })).toEqual([]);
  });

  it('rejects a rating outside 1–5', () => {
    expect(failingFields(CreateCustomerReviewDto, { rating: 0 })).toEqual([
      'rating',
    ]);
    expect(failingFields(CreateCustomerReviewDto, { rating: 6 })).toEqual([
      'rating',
    ]);
  });

  it('rejects a tag from the other direction’s vocabulary', () => {
    // `no_access` is a Pro's word about a household. A customer app sending it
    // is a bug, and a silently accepted one would pollute the tag counts on a
    // Pro's public profile.
    expect(
      failingFields(CreateCustomerReviewDto, {
        rating: 3,
        tags: ['no_access'],
      }),
    ).toEqual(['tags']);
  });

  it('rejects the same tag twice', () => {
    expect(
      failingFields(CreateCustomerReviewDto, {
        rating: 5,
        tags: ['punctual', 'punctual'],
      }),
    ).toEqual(['tags']);
  });
});
