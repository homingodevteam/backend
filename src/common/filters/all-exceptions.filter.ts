import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiErrorDetail,
  errorResponse,
  getErrorMessage,
  isApiResponse,
} from '../utils';

/**
 * Converts every failure — thrown HttpExceptions, ValidationPipe rejections
 * and unexpected crashes alike — into the same envelope the success path
 * uses, so a client never has to parse two different error shapes.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const path = request?.url;

    const { statusCode, message, errors } = this.describe(exception);

    // 5xx means we broke something — keep the stack. 4xx is the caller's
    // mistake and would only add noise at error level.
    if (statusCode >= 500) {
      this.logger.error(
        `${request?.method ?? 'UNKNOWN'} ${path ?? ''} -> ${statusCode}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request?.method ?? 'UNKNOWN'} ${path ?? ''} -> ${statusCode}: ${message}`,
      );
    }

    void reply
      .status(statusCode)
      .send(errorResponse({ message, statusCode, errors, path }));
  }

  private describe(exception: unknown): {
    statusCode: number;
    message: string;
    errors: ApiErrorDetail[] | null;
  } {
    if (!(exception instanceof HttpException)) {
      // Anything non-HTTP is a bug: report a generic message outward and
      // keep the real detail in the log above.
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
        errors: null,
      };
    }

    const statusCode = exception.getStatus();
    const body = exception.getResponse();

    // Thrown by apiError() — already our shape, so reuse it verbatim.
    if (isApiResponse(body)) {
      return {
        statusCode,
        message: body.message,
        errors: body.errors ?? null,
      };
    }

    if (typeof body === 'string') {
      return { statusCode, message: body, errors: null };
    }

    const record = body as Record<string, unknown>;
    const raw = record.message;

    // ValidationPipe returns message as string[] — one entry per broken
    // constraint. Surface them as structured errors rather than a blob.
    if (Array.isArray(raw)) {
      return {
        statusCode,
        message: 'Validation failed',
        errors: raw.map((entry) => ({ message: String(entry) })),
      };
    }

    return {
      statusCode,
      message: typeof raw === 'string' ? raw : getErrorMessage(exception),
      errors: null,
    };
  }
}
