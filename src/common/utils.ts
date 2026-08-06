import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The envelope every endpoint returns, success or failure. Keeping a single
 * shape means clients can branch on `success` alone and never have to guess
 * where the payload lives.
 */
export interface ApiResponse<T = null> {
  success: boolean;
  statusCode: number;
  message: string;
  data: T | null;
  /** Only present on failures. */
  errors?: ApiErrorDetail[] | null;
  timestamp: string;
  /** Request path, when the caller has it available (filters do). */
  path?: string;
}

/** A single field-level or domain-level failure. */
export interface ApiErrorDetail {
  field?: string;
  message: string;
  code?: string;
}

interface SuccessOptions<T> {
  data?: T | null;
  message?: string;
  statusCode?: number;
  path?: string;
}

interface ErrorOptions {
  message?: string;
  statusCode?: number;
  errors?: ApiErrorDetail[] | null;
  path?: string;
}

/**
 * Build a success envelope.
 *
 * @example
 *   return successResponse({ data: user, message: 'User fetched' });
 *   return successResponse({ data: created, statusCode: HttpStatus.CREATED });
 */
export function successResponse<T>({
  data = null,
  message = 'Success',
  statusCode = HttpStatus.OK,
  path,
}: SuccessOptions<T> = {}): ApiResponse<T> {
  return {
    success: true,
    statusCode,
    message,
    data,
    timestamp: new Date().toISOString(),
    ...(path ? { path } : {}),
  };
}

/**
 * Build an error envelope. Use this when you want to *return* a failure
 * shape (e.g. from an exception filter). To *abort* a request from inside
 * business logic, throw `apiError(...)` instead.
 */
export function errorResponse({
  message = 'Internal server error',
  statusCode = HttpStatus.INTERNAL_SERVER_ERROR,
  errors = null,
  path,
}: ErrorOptions = {}): ApiResponse<null> {
  return {
    success: false,
    statusCode,
    message,
    data: null,
    errors,
    timestamp: new Date().toISOString(),
    ...(path ? { path } : {}),
  };
}

/**
 * Throwable counterpart to `errorResponse`. Nest turns the thrown
 * HttpException into a response with the same envelope, so callers see one
 * consistent shape whether the failure was returned or thrown.
 *
 * @example
 *   if (!user) {
 *     throw apiError('User not found', HttpStatus.NOT_FOUND);
 *   }
 */
export function apiError(
  message: string,
  statusCode: number = HttpStatus.BAD_REQUEST,
  errors: ApiErrorDetail[] | null = null,
): HttpException {
  return new HttpException(
    errorResponse({ message, statusCode, errors }),
    statusCode,
  );
}

/**
 * Narrow an unknown thrown value to a message. `catch` blocks receive
 * `unknown`, and a non-Error can be thrown from anywhere in JS.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected error occurred';
}
