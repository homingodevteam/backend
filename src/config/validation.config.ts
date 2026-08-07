import type { ValidationPipeOptions } from '@nestjs/common';

/**
 * Shared so main.ts and the e2e tests configure validation identically —
 * a test proving rejection is worthless if it tests different options than
 * the app runs with.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  // Strip properties with no matching DTO decorator, so clients cannot
  // smuggle extra fields into an entity via a spread.
  whitelist: true,
  // ...and reject outright rather than silently dropping them, which would
  // otherwise let a typo'd field look like it saved successfully.
  forbidNonWhitelisted: true,
  // Turn plain JSON into DTO instances and coerce path/query params to their
  // declared types (`:id` arrives as a string otherwise).
  transform: true,
  transformOptions: { enableImplicitConversion: true },
};
