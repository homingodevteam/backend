import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../../config/validation.config';
import {
  CreateTrainingModuleDto,
  MarkAttendanceDto,
  UpdateTrainingModuleDto,
} from './training.dto';

/**
 * Validation behaviour that is easy to assume and easy to get wrong.
 *
 * Every case runs through `VALIDATION_PIPE_OPTIONS` — the same object
 * `main.ts` hands the global pipe — because a test proving rejection under
 * different options proves nothing about the running application.
 */
function failingFields(cls: new () => object, payload: unknown): string[] {
  const dto = plainToInstance(cls, payload, {
    enableImplicitConversion: true,
  });
  return validateSync(dto, VALIDATION_PIPE_OPTIONS)
    .map((error) => error.property)
    .sort();
}

describe('UpdateTrainingModuleDto', () => {
  /**
   * The reason this is `PartialType` and not three `@IsOptional() declare`
   * overrides: a `declare` field emits no property, so whether its decorators
   * apply is a question about compiler internals rather than something
   * readable from the source.
   */
  it('accepts a single field', () => {
    expect(
      failingFields(UpdateTrainingModuleDto, { title: 'New title' }),
    ).toEqual([]);
  });

  it('still validates the fields that are sent', () => {
    expect(
      failingFields(UpdateTrainingModuleDto, { categoryId: 'not-a-uuid' }),
    ).toEqual(['categoryId']);
  });

  it('rejects a field nobody declared', () => {
    // `forbidNonWhitelisted` — a typo'd field that silently vanished would
    // look to an admin exactly like a successful save.
    expect(failingFields(UpdateTrainingModuleDto, { titel: 'typo' })).toEqual([
      'titel',
    ]);
  });
});

describe('CreateTrainingModuleDto', () => {
  it('requires the three fields a module cannot exist without', () => {
    expect(failingFields(CreateTrainingModuleDto, {})).toEqual([
      'categoryId',
      'contentType',
      'title',
    ]);
  });
});

describe('MarkAttendanceDto', () => {
  const valid = {
    entries: [
      { proId: '2f1c4a5e-0000-4000-8000-000000000001', attended: true },
    ],
  };

  it('accepts a well-formed entry', () => {
    expect(failingFields(MarkAttendanceDto, valid)).toEqual([]);
  });

  /**
   * The bug this test exists for. `@IsObject({ each: true })` checks the
   * element is an object and stops — every field inside goes unvalidated, and
   * `forbidNonWhitelisted` never sees the extras either, so a `proId` of
   * "yes" would have reached Prisma. `@ValidateNested` is what descends.
   */
  it('validates inside each entry, not merely that it is an object', () => {
    expect(
      failingFields(MarkAttendanceDto, {
        entries: [{ proId: 'yes', attended: 'maybe' }],
      }),
    ).toEqual(['entries']);
  });

  it('rejects an empty list rather than silently marking nobody', () => {
    expect(failingFields(MarkAttendanceDto, { entries: [] })).toEqual([
      'entries',
    ]);
  });
});
