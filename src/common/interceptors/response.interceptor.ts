import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, map } from 'rxjs';
import { ApiResponse, isApiResponse, successResponse } from '../utils';

/**
 * Wraps every successful handler return value in the standard envelope, so
 * controllers can return plain data and still produce a consistent shape.
 *
 * Handlers that build their own envelope via successResponse() pass through
 * untouched — otherwise a custom message would be buried inside a second,
 * generic envelope.
 */

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T> | ApiResponse<unknown>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T> | ApiResponse<unknown>> {
    const http = context.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();

    return next.handle().pipe(
      map((data) => {
        if (isApiResponse(data)) return data;

        return successResponse<T>({
          data,
          // Respect a handler's @HttpCode(201) rather than always saying 200.
          statusCode: reply.statusCode,
          path: request.url,
        });
      }),
    );
  }
}
