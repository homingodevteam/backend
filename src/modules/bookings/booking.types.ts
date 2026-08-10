/** The nine states a booking can be in. */
export const BOOKING_STATUSES = [
  'created',
  'awaiting_payment',
  'assigning',
  'assigned',
  'en_route',
  'arrived',
  'started',
  'completed',
  'cancelled',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_TYPES = ['instant', 'scheduled', 'recurring'] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

/**
 * Frozen at creation, and the reason the state machine is not linear: a cash
 * booking skips `awaiting_payment` and has no `Order` row at all.
 */
export const PAYMENT_MODES = ['online', 'cash'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_STATUSES = [
  'unpaid',
  'authorized',
  'paid',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** A Pro is deliberately absent — principle 2, a Pro cannot cancel. */
export const CANCELLED_BY_TYPES = ['customer', 'ops', 'system'] as const;
export type CancelledByType = (typeof CANCELLED_BY_TYPES)[number];

/** Who caused a transition. `pro` may act, but may never cancel. */
export const ACTOR_TYPES = ['customer', 'pro', 'ops', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const PHOTO_TYPES = ['before', 'after', 'completion'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

export const RECURRENCE_FREQUENCIES = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/**
 * The six cancellation windows. Which one a booking falls in is decided by its
 * status alone, and that decides the refund, the fee and whether ops must be
 * involved.
 */
export type CancellationWindow = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** Coordinates captured at a transition — evidence, not decoration. */
export interface TransitionCoordinates {
  lat?: number;
  lng?: number;
}

/**
 * The legal transitions, as data rather than as scattered `if`s.
 *
 * `created` has two successors and the one that is legal depends on
 * `paymentMode` — see `isTransitionAllowed`. That fork is the whole reason
 * feature 8's linear list could not be implemented literally.
 */
export const ALLOWED_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  created: ['awaiting_payment', 'assigning', 'cancelled'],
  awaiting_payment: ['assigning', 'cancelled'],
  assigning: ['assigned', 'cancelled'],
  assigned: ['en_route', 'assigning', 'cancelled'],
  // en_route ⇄ arrived repeats freely: the customer isn't home, the Pro
  // leaves and comes back. Feature 10 requires every leg to survive.
  en_route: ['arrived', 'cancelled'],
  arrived: ['en_route', 'started', 'cancelled'],
  started: ['completed', 'cancelled'],
  // Terminal. A completed job is disputed, never cancelled.
  completed: [],
  cancelled: [],
};

/**
 * Whether `from → to` is legal for a booking in this payment mode.
 *
 * The only mode-dependent edge is out of `created`: an online booking must
 * pass through `awaiting_payment`, and a cash booking must not — it dispatches
 * before any money moves.
 */
export function isTransitionAllowed(
  from: BookingStatus,
  to: BookingStatus,
  paymentMode: PaymentMode,
): boolean {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) return false;

  if (from === 'created') {
    if (to === 'awaiting_payment') return paymentMode === 'online';
    if (to === 'assigning') return paymentMode === 'cash';
  }

  return true;
}

/** Statuses from which a booking is still live work, not history. */
export const TERMINAL_STATUSES: BookingStatus[] = ['completed', 'cancelled'];

export function isTerminal(status: BookingStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Which cancellation window a booking is in, from its status alone.
 *
 * Returns `null` only for `cancelled` — already cancelled is not a window.
 */
export function cancellationWindowFor(
  status: BookingStatus,
): CancellationWindow | null {
  switch (status) {
    case 'created':
    case 'awaiting_payment':
      return 'A';
    case 'assigning':
      return 'B';
    case 'assigned':
      return 'C';
    case 'en_route':
    case 'arrived':
      return 'D';
    case 'started':
      return 'E';
    case 'completed':
      return 'F';
    default:
      return null;
  }
}

/** Window E is a judgement call, not a formula — it must route to a human. */
export function windowRequiresOps(window: CancellationWindow): boolean {
  return window === 'E';
}

/** Only window D carries a fee. A–C are the platform's own cost. */
export function windowChargesFee(window: CancellationWindow): boolean {
  return window === 'D';
}
