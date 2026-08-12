import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { RazorpayXOptions } from '../../config/razorpayx.config';

export const RAZORPAYX_OPTIONS = Symbol('RAZORPAYX_OPTIONS');

/**
 * Thrown when RazorpayX itself refuses or fails.
 *
 * `retryable` is the field that matters. A 4xx means the request was wrong and
 * sending it again will be wrong again — a missing fund account, an invalid
 * IFSC. A 5xx or a timeout means we do not know whether the transfer happened,
 * which is a completely different situation and the reason every call carries
 * an idempotency key.
 */
export class RazorpayXError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly description?: string,
  ) {
    super(message);
    this.name = 'RazorpayXError';
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 0;
  }
}

export interface RazorpayXContact {
  id: string;
  name: string;
  type?: string;
}

export interface RazorpayXFundAccount {
  id: string;
  contact_id: string;
  account_type: 'bank_account' | 'vpa';
  active: boolean;
}

export interface RazorpayXPayout {
  id: string;
  fund_account_id: string;
  amount: number;
  currency: string;
  /**
   * `queued` → `pending` → `processing` → `processed`, or `reversed` /
   * `cancelled` / `failed`. Only `processed` means the money arrived.
   */
  status: string;
  utr?: string | null;
  mode: string;
  reference_id?: string | null;
  failure_reason?: string | null;
  created_at: number;
}

/**
 * The four RazorpayX calls this module makes, over `fetch`.
 *
 * Same shape and the same reasoning as module 7's `RazorpayClient` — no vendor
 * package, retries and error mapping written out where they can be read — but
 * a **separate class**, because RazorpayX is a separate product with separate
 * credentials and a separate base path. Sharing the client would mean one set
 * of keys authenticating against two products, which fails in a way that looks
 * like an outage rather than a misconfiguration.
 *
 * Money crosses this boundary as integer paise only.
 */
@Injectable()
export class RazorpayXClient {
  private readonly logger = new Logger(RazorpayXClient.name);
  private readonly authHeader: string;

  /**
   * Longer than the payments client's 15s. A payout is submitted by an admin
   * who has already decided, not by a customer waiting at a checkout, and
   * giving up early on a request that may well have moved money is the worst
   * of both outcomes.
   */
  private static readonly TIMEOUT_MS = 30_000;

  constructor(
    @Optional()
    @Inject(RAZORPAYX_OPTIONS)
    private readonly options?: RazorpayXOptions,
  ) {
    this.authHeader = options
      ? `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64')}`
      : '';
  }

  get isConfigured(): boolean {
    return this.options !== undefined;
  }

  get webhookSecret(): string {
    return this.require().webhookSecret;
  }

  private require(): RazorpayXOptions {
    if (!this.options) {
      throw new RazorpayXError(
        'RazorpayX is not configured on this deployment',
        503,
        'PAYOUT_GATEWAY_NOT_CONFIGURED',
      );
    }
    return this.options;
  }

  /** The person money is sent to. Created once per Pro and reused. */
  createContact(input: {
    name: string;
    contact?: string;
    email?: string;
    referenceId: string;
  }): Promise<RazorpayXContact> {
    return this.request<RazorpayXContact>('POST', '/contacts', {
      name: input.name,
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.email ? { email: input.email } : {}),
      type: 'employee',
      reference_id: input.referenceId,
    });
  }

  /**
   * The instrument money lands in. Created once per bank account row and reused.
   *
   * Only the VPA branch is reachable from what this platform stores:
   * `ProBankAccount.accountNumberMasked` is masked and cannot be paid to. The
   * bank branch is here because module 2's verification step is where an
   * unmasked number exists, and that is the seam it will call through.
   */
  createFundAccount(input: {
    contactId: string;
    vpa?: { address: string };
    bankAccount?: { name: string; ifsc: string; accountNumber: string };
  }): Promise<RazorpayXFundAccount> {
    if (input.vpa) {
      return this.request<RazorpayXFundAccount>('POST', '/fund_accounts', {
        contact_id: input.contactId,
        account_type: 'vpa',
        vpa: { address: input.vpa.address },
      });
    }

    return this.request<RazorpayXFundAccount>('POST', '/fund_accounts', {
      contact_id: input.contactId,
      account_type: 'bank_account',
      bank_account: {
        name: input.bankAccount?.name,
        ifsc: input.bankAccount?.ifsc,
        account_number: input.bankAccount?.accountNumber,
      },
    });
  }

  /**
   * Move the money.
   *
   * `idempotencyKey` goes out as `X-Payout-Idempotency`. Within RazorpayX's
   * window, a repeat of the same key returns the **original** payout rather
   * than creating a second one — which is exactly what a network timeout needs,
   * and exactly why a deliberate retry after a confirmed failure must mint a
   * new key instead of reusing this one.
   */
  createPayout(input: {
    fundAccountId: string;
    amountPaise: number;
    mode: 'IMPS' | 'NEFT' | 'UPI';
    referenceId: string;
    narration: string;
    idempotencyKey: string;
    notes?: Record<string, string>;
  }): Promise<RazorpayXPayout> {
    return this.request<RazorpayXPayout>(
      'POST',
      '/payouts',
      {
        account_number: this.require().accountNumber,
        fund_account_id: input.fundAccountId,
        amount: input.amountPaise,
        currency: 'INR',
        mode: input.mode,
        purpose: 'salary',
        queue_if_low_balance: true,
        reference_id: input.referenceId,
        // RazorpayX truncates this to 30 characters on the bank statement.
        narration: input.narration.slice(0, 30),
        ...(input.notes ? { notes: input.notes } : {}),
      },
      { 'X-Payout-Idempotency': input.idempotencyKey },
    );
  }

  /** Read a payout back. The reconciliation path when a webhook is missed. */
  fetchPayout(payoutId: string): Promise<RazorpayXPayout> {
    return this.request<RazorpayXPayout>(
      'GET',
      `/payouts/${encodeURIComponent(payoutId)}`,
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const url = `${this.require().baseUrl}${path}`;
    const response = await this.send(method, url, body, headers);
    const text = await response.text();

    if (!response.ok) throw this.toError(response.status, text, method, path);

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RazorpayXError(
        `RazorpayX returned a non-JSON body for ${method} ${path}`,
        response.status,
      );
    }
  }

  private async send(
    method: 'GET' | 'POST',
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(RazorpayXClient.TIMEOUT_MS),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'unknown';
      // Status 0 rather than 503: the request may have arrived and the money
      // may already be moving. The caller must treat this as "unknown", not as
      // "failed", and reconcile — which is what `retryable` and the
      // idempotency key are both for.
      throw new RazorpayXError(
        `Could not reach RazorpayX: ${reason}`,
        0,
        'PAYOUT_GATEWAY_UNREACHABLE',
      );
    }
  }

  private toError(
    status: number,
    text: string,
    method: string,
    path: string,
  ): RazorpayXError {
    let code: string | undefined;
    let description: string | undefined;

    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: string; description?: string };
      };
      code = parsed.error?.code;
      description = parsed.error?.description;
    } catch {
      // An HTML error page. The status is still the useful part.
    }

    this.logger.error(
      `RazorpayX ${method} ${path} failed with ${status}: ${description ?? text.slice(0, 200)}`,
    );

    return new RazorpayXError(
      `RazorpayX ${method} ${path} failed with ${status}`,
      status,
      code,
      description,
    );
  }
}
