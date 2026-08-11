import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { RazorpayOptions } from '../../config/razorpay.config';

export const RAZORPAY_OPTIONS = Symbol('RAZORPAY_OPTIONS');

/**
 * Thrown when the gateway itself refuses or fails. Never returned to a client
 * as-is — the caller decides what the customer sees, because Razorpay's own
 * error text is written for a developer reading their dashboard.
 */
export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly description?: string,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: string;
  attempts: number;
  notes?: Record<string, string>;
  created_at: number;
}

export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string;
  captured?: boolean;
  error_code?: string | null;
  error_description?: string | null;
  created_at: number;
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: string;
  speed_processed?: string;
  created_at: number;
}

export interface RazorpayCustomer {
  id: string;
  name?: string;
  contact?: string;
  email?: string;
}

/**
 * The six gateway calls this module makes, over `fetch`.
 *
 * There is no `razorpay` package dependency, and that is a decision rather
 * than an oversight: the surface used here is six endpoints behind HTTP Basic
 * auth, and `package.json` is one of the two files that conflicts hardest
 * between parallel branches. The cost is ours to carry — retries, timeouts and
 * error mapping are hand-written here, which is why they are visible rather
 * than buried in a vendor library.
 *
 * Money never crosses this boundary as rupees. Every `amount` in and out is
 * integer paise; conversion belongs to the caller and lives in
 * `payments.money.ts`.
 */
@Injectable()
export class RazorpayClient {
  private readonly logger = new Logger(RazorpayClient.name);
  private readonly authHeader: string;

  /** Long enough for a slow gateway, short enough not to hold a request open. */
  private static readonly TIMEOUT_MS = 15_000;

  /**
   * `options` is optional because the app must boot without gateway
   * credentials — cash is the default payment mode and needs none. Every
   * accessor below goes through `require()`, so an unconfigured deployment
   * fails at the point of use with a sentence, rather than at boot with a
   * stack trace on a path it was never going to take.
   */
  constructor(
    @Optional()
    @Inject(RAZORPAY_OPTIONS)
    private readonly options?: RazorpayOptions,
  ) {
    this.authHeader = options
      ? `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64')}`
      : '';
  }

  get isConfigured(): boolean {
    return this.options !== undefined;
  }

  /** The publishable half of the key pair — safe to hand to the app. */
  get publicKeyId(): string {
    return this.require().keyId;
  }

  /**
   * The checkout-signature key, exposed only so `razorpay.signature.ts` can
   * be a pure function rather than reaching for config itself. Never returned
   * from a controller, and deliberately named so that a call site which
   * leaked it would read wrong.
   */
  get keySecretForSignature(): string {
    return this.require().keySecret;
  }

  /** Webhook deliveries are signed with this, not the API key secret. */
  get webhookSecret(): string {
    return this.require().webhookSecret;
  }

  private require(): RazorpayOptions {
    if (!this.options) {
      throw new RazorpayError(
        'Razorpay is not configured on this deployment',
        503,
        'GATEWAY_NOT_CONFIGURED',
      );
    }
    return this.options;
  }

  createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<RazorpayOrder> {
    return this.request<RazorpayOrder>('POST', '/orders', {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    });
  }

  fetchOrder(razorpayOrderId: string): Promise<RazorpayOrder> {
    return this.request<RazorpayOrder>(
      'GET',
      `/orders/${encodeURIComponent(razorpayOrderId)}`,
    );
  }

  fetchPayment(razorpayPaymentId: string): Promise<RazorpayPayment> {
    return this.request<RazorpayPayment>(
      'GET',
      `/payments/${encodeURIComponent(razorpayPaymentId)}`,
    );
  }

  /**
   * The attempt history the admin console deliberately does not store. Support
   * reaches it by order id, here or in Razorpay's own dashboard.
   */
  async fetchPaymentsForOrder(
    razorpayOrderId: string,
  ): Promise<RazorpayPayment[]> {
    const response = await this.request<{ items: RazorpayPayment[] }>(
      'GET',
      `/orders/${encodeURIComponent(razorpayOrderId)}/payments`,
    );
    return response.items ?? [];
  }

  /**
   * Partial when `amountPaise` is given, full when it is omitted — Razorpay's
   * own convention, kept rather than translated.
   */
  createRefund(input: {
    razorpayPaymentId: string;
    amountPaise?: number;
    notes?: Record<string, string>;
  }): Promise<RazorpayRefund> {
    return this.request<RazorpayRefund>(
      'POST',
      `/payments/${encodeURIComponent(input.razorpayPaymentId)}/refund`,
      {
        ...(input.amountPaise === undefined
          ? {}
          : { amount: input.amountPaise }),
        ...(input.notes ? { notes: input.notes } : {}),
      },
    );
  }

  /**
   * Feature 9's storage boundary. Creating the gateway customer is what lets
   * Razorpay offer saved cards and VPAs at checkout; **only the returned id**
   * comes back to us. No instrument detail is stored on the platform, and
   * there is no column that could hold it.
   */
  createCustomer(input: {
    name?: string;
    contact?: string;
    email?: string;
  }): Promise<RazorpayCustomer> {
    return this.request<RazorpayCustomer>('POST', '/customers', {
      ...(input.name ? { name: input.name } : {}),
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.email ? { email: input.email } : {}),
      // Returns the existing customer instead of a 400 when the contact is
      // already known — otherwise a customer who cleared their app data could
      // never check out again.
      fail_existing: '0',
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.require().baseUrl}${path}`;
    const response = await this.send(method, url, body);
    const text = await response.text();

    if (!response.ok) {
      throw this.toError(response.status, text, method, path);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RazorpayError(
        `Razorpay returned a non-JSON body for ${method} ${path}`,
        response.status,
      );
    }
  }

  private async send(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<Response> {
    // A hung socket must not hold a customer's checkout request open until the
    // platform's own timeout. AbortSignal.timeout is the whole retry policy:
    // there is none. Retrying a POST /orders would create a second order and a
    // second charge surface, and retrying a refund would refund twice.
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(RazorpayClient.TIMEOUT_MS),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'unknown';
      throw new RazorpayError(`Could not reach Razorpay: ${reason}`, 503);
    }
  }

  private toError(
    status: number,
    text: string,
    method: string,
    path: string,
  ): RazorpayError {
    let code: string | undefined;
    let description: string | undefined;

    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: string; description?: string };
      };
      code = parsed.error?.code;
      description = parsed.error?.description;
    } catch {
      // Razorpay occasionally returns an HTML error page. The status is still
      // the useful part.
    }

    // Logged in full here so the cause is recoverable; the message that
    // reaches a customer is written by the caller, never by the gateway.
    this.logger.error(
      `Razorpay ${method} ${path} failed with ${status}: ${description ?? text.slice(0, 200)}`,
    );

    return new RazorpayError(
      `Razorpay ${method} ${path} failed with ${status}`,
      status,
      code,
      description,
    );
  }
}
