/**
 * The vocabulary of module 7, and the forward-only rules that make webhook
 * replay safe.
 */

export const ORDER_STATUSES = ['created', 'attempted', 'paid'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const REFUND_STATUSES = [
  'none',
  'initiated',
  'settled',
  'failed',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'unpaid',
  'authorized',
  'paid',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Razorpay does **not** guarantee webhook ordering, and in practice
 * `payment.captured` regularly arrives before `payment.authorized` for the
 * same payment. Without a rank, that pair alone would leave a genuinely paid
 * order sitting at `attempted` — money taken, booking never dispatched.
 *
 * So every status write goes through {@link advanceStatus}, which is a max,
 * not an assignment.
 */
const ORDER_STATUS_RANK: Record<OrderStatus, number> = {
  created: 0,
  attempted: 1,
  paid: 2,
};

/**
 * `initiated` and `settled` are the two states the customer must be able to
 * tell apart — the refund call returns immediately, the money lands 5–7
 * working days later.
 *
 * `failed` sits **above** `settled` deliberately: a refund that failed after
 * being initiated must be visible, and it is terminal for that attempt. It
 * cannot be reached from `settled`, which the guard below enforces separately.
 */
const REFUND_STATUS_RANK: Record<RefundStatus, number> = {
  none: 0,
  initiated: 1,
  settled: 2,
  failed: 3,
};

/**
 * Returns whichever status is further along. Applying an out-of-order webhook
 * therefore changes nothing rather than moving the order backwards, which is
 * half of what makes duplicate deliveries safe (the other half is that every
 * other written field is set from the event payload, identically each time).
 */
export function advanceStatus(
  current: OrderStatus,
  incoming: OrderStatus,
): OrderStatus {
  return ORDER_STATUS_RANK[incoming] > ORDER_STATUS_RANK[current]
    ? incoming
    : current;
}

export function advanceRefundStatus(
  current: RefundStatus,
  incoming: RefundStatus,
): RefundStatus {
  // Settled money cannot un-settle. A late `refund.failed` after a
  // `refund.processed` is a gateway artefact, not a reversal.
  if (current === 'settled' && incoming === 'failed') return current;

  return REFUND_STATUS_RANK[incoming] > REFUND_STATUS_RANK[current]
    ? incoming
    : current;
}

/** True when applying `incoming` would actually move the order forward. */
export function isForwardStatus(
  current: OrderStatus,
  incoming: OrderStatus,
): boolean {
  return ORDER_STATUS_RANK[incoming] > ORDER_STATUS_RANK[current];
}

/**
 * The webhook events this module acts on. Razorpay sends many more; anything
 * absent from here is acknowledged and ignored rather than treated as an
 * error, so enabling an extra event in their dashboard cannot break us.
 */
export const HANDLED_WEBHOOK_EVENTS = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'refund.created',
  'refund.processed',
  'refund.failed',
] as const;
export type HandledWebhookEvent = (typeof HANDLED_WEBHOOK_EVENTS)[number];

export function isHandledEvent(event: string): event is HandledWebhookEvent {
  return (HANDLED_WEBHOOK_EVENTS as readonly string[]).includes(event);
}

/** Platform setting keys this module owns. No magic numbers. */
export const PAYMENT_SETTINGS = {
  cashEnabled: 'payments.cashEnabled',
  cashCeiling: 'payments.cashInHandCeilingAmount',
  orderValidityMinutes: 'payments.orderValidityMinutes',
  reconciliationVarianceTolerance: 'payments.reconciliationVarianceTolerance',
  webhookDedupeTtlDays: 'payments.webhookDedupeTtlDays',
} as const;
