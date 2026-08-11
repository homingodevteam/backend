import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError, getErrorMessage } from '../../common/utils';
import { RedisService } from '../../redis/redis.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import { OrdersService } from './orders.service';
import { PAYMENT_SETTINGS, isHandledEvent } from './payments.types';
import { RazorpayClient } from './razorpay.client';
import { verifyWebhookSignature } from './razorpay.signature';
import { RefundsService } from './refunds.service';

/** Only the parts of Razorpay's payload this module reads. */
interface WebhookEnvelope {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayPaymentEntity };
    refund?: { entity?: RazorpayRefundEntity };
  };
}

interface RazorpayPaymentEntity {
  id?: string;
  order_id?: string | null;
  amount?: number;
  status?: string;
  method?: string | null;
  error_code?: string | null;
}

interface RazorpayRefundEntity {
  id?: string;
  payment_id?: string;
  amount?: number;
  status?: string;
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'failed';

@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly razorpay: RazorpayClient,
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
    private readonly redis: RedisService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * Feature 4 and 5, and the one place a gateway event becomes a fact.
   *
   * The contract with Razorpay is narrow and deliberate:
   *
   * - **401 only for a bad signature.** That is the single failure worth
   *   retrying, and the single one an attacker could provoke.
   * - **200 for everything else**, including our own bugs. Razorpay retries a
   *   non-2xx for 24 hours; retrying a broken write does not fix it, it just
   *   runs it 40 more times. Whatever we drop is found by reconciliation,
   *   which is what feature 10 is for.
   */
  async handle(input: {
    rawBody: Buffer | string | undefined;
    signature: string | undefined;
  }): Promise<{ outcome: WebhookOutcome; event: string | null }> {
    if (!input.rawBody) {
      // Reaching here means `rawBody: true` was lost from main.ts. Failing
      // loudly beats silently verifying against a re-serialised body, which
      // would reject genuine deliveries for reasons nobody could reproduce.
      this.logger.error(
        'Webhook received with no raw body — rawBody must be enabled in main.ts.',
      );
      throw apiError('Webhook could not be verified', HttpStatus.UNAUTHORIZED);
    }

    const verified = verifyWebhookSignature({
      rawBody: input.rawBody,
      signature: input.signature ?? '',
      webhookSecret: this.razorpay.webhookSecret,
    });

    if (!verified) {
      this.logger.warn('Rejected a webhook delivery with an invalid signature');
      throw apiError('Webhook could not be verified', HttpStatus.UNAUTHORIZED);
    }

    const body = this.parse(input.rawBody);
    const event = body?.event ?? null;

    if (!body || !event) {
      this.logger.warn('Verified webhook carried no readable event');
      return { outcome: 'ignored', event };
    }

    if (!isHandledEvent(event)) {
      // Enabling an extra event in the Razorpay dashboard is an ops action
      // with no deploy behind it, so an unknown event is acknowledged rather
      // than treated as an error.
      this.logger.debug(`Ignoring unhandled Razorpay event ${event}`);
      return { outcome: 'ignored', event };
    }

    const fresh = await this.claim(event, body);
    if (!fresh) return { outcome: 'duplicate', event };

    try {
      await this.dispatchEvent(event, body);
      return { outcome: 'processed', event };
    } catch (cause) {
      // Swallowed on purpose — see the contract above.
      this.logger.error(
        `Failed to process ${event}: ${getErrorMessage(cause)}`,
        cause instanceof Error ? cause.stack : undefined,
      );
      return { outcome: 'failed', event };
    }
  }

  private async dispatchEvent(
    event: string,
    body: WebhookEnvelope,
  ): Promise<void> {
    const payment = body.payload?.payment?.entity;
    const refund = body.payload?.refund?.entity;

    switch (event) {
      case 'payment.captured': {
        const facts = this.captureFacts(payment);
        if (facts) await this.orders.applyCapture(facts);
        return;
      }

      case 'payment.authorized': {
        const facts = this.captureFacts(payment);
        if (facts) await this.orders.applyAuthorized(facts);
        return;
      }

      case 'payment.failed': {
        if (!payment?.order_id) return;
        await this.orders.applyFailure({
          razorpayOrderId: payment.order_id,
          failureCode: payment.error_code ?? null,
        });
        return;
      }

      case 'refund.created':
        if (refund?.id && refund.payment_id) {
          await this.refunds.applyRefundInitiated(refund.id, refund.payment_id);
        }
        return;

      case 'refund.processed':
        if (refund?.id && refund.payment_id) {
          await this.refunds.applyRefundSettled({
            razorpayRefundId: refund.id,
            razorpayPaymentId: refund.payment_id,
            amountPaise: refund.amount ?? 0,
          });
        }
        return;

      case 'refund.failed':
        if (refund?.id && refund.payment_id) {
          await this.refunds.applyRefundFailed(refund.id, refund.payment_id);
        }
        return;

      default:
        return;
    }
  }

  private captureFacts(payment: RazorpayPaymentEntity | undefined) {
    if (!payment?.id || !payment.order_id || payment.amount === undefined) {
      this.logger.warn(
        'Payment event carried no id, order or amount — nothing to apply',
      );
      return null;
    }

    return {
      razorpayOrderId: payment.order_id,
      razorpayPaymentId: payment.id,
      amountPaise: payment.amount,
      method: payment.method,
    };
  }

  /**
   * The fast path past a redelivery, and **only** a fast path.
   *
   * Correctness never rests on it: every write downstream is convergent and
   * every status move is forward-only, so a Redis flush replays events
   * harmlessly. That is what makes it acceptable to keep the dedupe record
   * somewhere volatile instead of inventing a `WebhookEvent` table — the exact
   * local copy of gateway data this module exists not to keep.
   *
   * When Redis itself is unreachable, the event is let through rather than
   * dropped. Processing twice is safe by construction; not processing at all
   * leaves a paid booking undispatched.
   */
  private async claim(event: string, body: WebhookEnvelope): Promise<boolean> {
    const id =
      body.payload?.payment?.entity?.id ?? body.payload?.refund?.entity?.id;
    if (!id) return true;

    const days = await this.settings.getNumber(
      PAYMENT_SETTINGS.webhookDedupeTtlDays,
      7,
    );

    try {
      return await this.redis.setIfAbsent(
        `rzp:evt:${event}:${id}`,
        new Date().toISOString(),
        Math.round(days * 24 * 60 * 60),
      );
    } catch (cause) {
      this.logger.warn(
        `Could not reach Redis to de-duplicate ${event} for ${id}; processing ` +
          `anyway, which is safe: ${getErrorMessage(cause)}`,
      );
      return true;
    }
  }

  private parse(rawBody: Buffer | string): WebhookEnvelope | null {
    const text =
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

    try {
      return JSON.parse(text) as WebhookEnvelope;
    } catch {
      return null;
    }
  }
}
