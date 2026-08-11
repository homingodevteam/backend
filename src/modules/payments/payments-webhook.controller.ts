import { Controller, Headers, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import { PaymentWebhookService } from './payment-webhook.service';

/** `rawBody: true` in main.ts is what puts this on the request. */
type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * Razorpay's callback. **The only unauthenticated write endpoint in this API.**
 *
 * That is not an oversight and it is stated here so a reviewer never has to
 * infer it: Razorpay cannot hold a bearer token, so the request authenticates
 * itself with an HMAC over its own body, keyed with a secret only they and we
 * hold. No guard could do better, and a guard that rejected them would take
 * the platform's payment confirmations offline.
 *
 * Two further deliberate departures from house convention:
 *
 * 1. **No DTO, no ValidationPipe.** The body is Razorpay's, deeply nested and
 *    versioned by them. `forbidNonWhitelisted` would 400 every delivery the
 *    day they add a field (CONFLICTS_AND_DECISIONS #39).
 * 2. **200 on our own processing failure.** Razorpay retries a non-2xx for 24
 *    hours; retrying a code bug just runs it 40 more times. Only a bad
 *    signature returns non-2xx.
 */
@ApiTags('Payments')
@Controller('payments/razorpay')
export class PaymentsWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post('webhook')
  @ApiOperation({
    summary: 'Razorpay webhook receiver',
    description:
      'Authenticated by `x-razorpay-signature`, an HMAC-SHA256 over the raw ' +
      'request body. Idempotent: duplicate deliveries are safe by ' +
      'construction, not by a dedupe table.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  // Hidden from the published contract: it is Razorpay's endpoint, not a
  // client's, and documenting it invites someone to call it.
  @ApiExcludeEndpoint()
  async receive(
    @Req() request: RawBodyRequest,
    @Headers('x-razorpay-signature') signature?: string,
  ): Promise<void> {
    await this.webhooks.handle({ rawBody: request.rawBody, signature });
  }
}
