import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { verifyWebhookSignature } from '../payments/razorpay.signature';
import { PayoutDisbursementService } from './payout-disbursement.service';
import { RazorpayXClient } from './razorpayx.client';

interface RazorpayXWebhookEnvelope {
  event?: string;
  payload?: {
    payout?: {
      entity?: {
        id?: string;
        status?: string;
        utr?: string | null;
        failure_reason?: string | null;
        reference_id?: string | null;
      };
    };
  };
}

/**
 * RazorpayX's callback — the thing that actually decides whether a Pro was
 * paid.
 *
 * `verifyWebhookSignature` is imported from module 7 rather than reimplemented.
 * It is a pure function over a buffer and a secret with no Nest wiring, both
 * products sign the same way, and having two hand-rolled timing-safe HMAC
 * comparisons in one codebase is how one of them ends up subtly wrong. The
 * *secret* is this module's own.
 */
@Injectable()
export class PayoutWebhookService {
  private readonly logger = new Logger(PayoutWebhookService.name);

  constructor(
    private readonly razorpayx: RazorpayXClient,
    private readonly disbursement: PayoutDisbursementService,
  ) {}

  async handle(input: {
    rawBody?: Buffer | string;
    signature?: string;
  }): Promise<void> {
    if (!this.razorpayx.isConfigured) {
      this.logger.warn(
        'A RazorpayX webhook arrived on a deployment with no payout credentials. Ignoring.',
      );
      return;
    }

    if (!input.rawBody || !input.signature) {
      throw apiError('Unsigned webhook delivery', HttpStatus.UNAUTHORIZED);
    }

    const authentic = verifyWebhookSignature({
      rawBody: input.rawBody,
      signature: input.signature,
      webhookSecret: this.razorpayx.webhookSecret,
    });
    if (!authentic) {
      // The one case that returns non-2xx. Everything else answers 200 so
      // RazorpayX stops retrying a bug at us for 24 hours.
      throw apiError('Invalid webhook signature', HttpStatus.UNAUTHORIZED);
    }

    let event: RazorpayXWebhookEnvelope;
    try {
      event = JSON.parse(input.rawBody.toString()) as RazorpayXWebhookEnvelope;
    } catch {
      this.logger.error('RazorpayX webhook body was signed but is not JSON.');
      return;
    }

    const entity = event.payload?.payout?.entity;
    if (!entity?.id) {
      this.logger.warn(
        `RazorpayX webhook ${event.event ?? 'unknown'} carried no payout entity.`,
      );
      return;
    }

    /**
     * Driven by the entity's own `status`, not by the event name.
     *
     * Deliveries arrive out of order often enough to matter, and the entity is
     * always the current truth while the event name is only what happened at
     * some point. Reading the status also means an unknown future event type
     * still lands on the right branch instead of being dropped.
     */
    switch (entity.status) {
      case 'processed':
        await this.disbursement.settle(entity.id, entity.utr ?? entity.id);
        return;

      case 'reversed':
      case 'cancelled':
      case 'failed':
        await this.disbursement.markFailed(
          entity.id,
          entity.failure_reason ??
            `RazorpayX reported the payout as ${entity.status}`,
        );
        return;

      default:
        // queued / pending / processing — in flight. Nothing to record: the
        // batch already says `processing`, and writing an intermediate state
        // would only add rows for a machine to change again.
        this.logger.log(
          `Payout ${entity.id} is ${entity.status ?? 'in an unknown state'}; still in flight.`,
        );
    }
  }
}
