import { Controller, Headers, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import { PayoutWebhookService } from './payout-webhook.service';

/** `rawBody: true` in main.ts is what puts this on the request. */
type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

/**
 * RazorpayX's callback — the thing that decides whether a Pro was actually
 * paid.
 *
 * The **second** unauthenticated write endpoint in this API, and it is here for
 * the same reason as the first: a bank cannot hold a bearer token, so the
 * request authenticates itself with an HMAC over its own body keyed with a
 * secret only they and we hold.
 *
 * Mounted on its own path rather than beside module 7's, because the two
 * products sign with **different secrets** — pointing both at one handler would
 * mean every delivery from one of them failing verification, which looks
 * exactly like an attack and is exactly not one.
 *
 * Same three departures from house convention as module 7's webhook, for the
 * same reasons: no DTO (the body is RazorpayX's and they version it), 200 on
 * our own processing failures (a non-2xx makes them retry a code bug for 24
 * hours), and only a bad signature returns non-2xx.
 */
@ApiTags('Payouts')
@Controller('payouts/razorpayx')
export class PayoutWebhookController {
  constructor(private readonly webhooks: PayoutWebhookService) {}

  @Post('webhook')
  @ApiOperation({
    summary: 'RazorpayX payout webhook receiver',
    description:
      'Authenticated by `x-razorpay-signature`, an HMAC-SHA256 over the raw ' +
      'request body keyed with the RazorpayX webhook secret. Idempotent: ' +
      'settlement is convergent, so a redelivery changes nothing.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  @ApiExcludeEndpoint()
  async receive(
    @Req() request: RawBodyRequest,
    @Headers('x-razorpay-signature') signature?: string,
  ): Promise<void> {
    await this.webhooks.handle({ rawBody: request.rawBody, signature });
  }
}
