import {
  ALLOWED_TRANSITIONS,
  BOOKING_STATUSES,
  cancellationWindowFor,
  isTerminal,
  isTransitionAllowed,
  windowChargesFee,
  windowRequiresOps,
  type BookingStatus,
} from './booking.types';

/** Every (from, to) pair, so nothing legal is asserted without its inverse. */
const ALL_PAIRS: Array<[BookingStatus, BookingStatus]> =
  BOOKING_STATUSES.flatMap((from) =>
    BOOKING_STATUSES.map((to) => [from, to] as [BookingStatus, BookingStatus]),
  );

describe('booking state machine', () => {
  describe('the payment-mode fork out of `created`', () => {
    it('lets a cash booking dispatch immediately', () => {
      expect(isTransitionAllowed('created', 'assigning', 'cash')).toBe(true);
    });

    it('refuses to dispatch an online booking before it is paid', () => {
      expect(isTransitionAllowed('created', 'assigning', 'online')).toBe(false);
    });

    it('sends an online booking to awaiting_payment', () => {
      expect(isTransitionAllowed('created', 'awaiting_payment', 'online')).toBe(
        true,
      );
    });

    it('never puts a cash booking in awaiting_payment — money moves at the door', () => {
      expect(isTransitionAllowed('created', 'awaiting_payment', 'cash')).toBe(
        false,
      );
    });
  });

  describe('repeat transitions — feature 10', () => {
    it('allows arrived → en_route → arrived when a customer is not home', () => {
      expect(isTransitionAllowed('arrived', 'en_route', 'cash')).toBe(true);
      expect(isTransitionAllowed('en_route', 'arrived', 'cash')).toBe(true);
    });
  });

  describe('terminal states', () => {
    it('lets nothing out of completed — a finished job is disputed, not cancelled', () => {
      for (const to of BOOKING_STATUSES) {
        expect(isTransitionAllowed('completed', to, 'cash')).toBe(false);
      }
    });

    it('lets nothing out of cancelled', () => {
      for (const to of BOOKING_STATUSES) {
        expect(isTransitionAllowed('cancelled', to, 'cash')).toBe(false);
      }
    });

    it('reports both as terminal', () => {
      expect(isTerminal('completed')).toBe(true);
      expect(isTerminal('cancelled')).toBe(true);
      expect(isTerminal('started')).toBe(false);
    });
  });

  describe('cancellation is reachable throughout, but only from live states', () => {
    const live: BookingStatus[] = [
      'created',
      'awaiting_payment',
      'assigning',
      'assigned',
      'en_route',
      'arrived',
      'started',
    ];

    it.each(live)('allows %s → cancelled', (from) => {
      expect(isTransitionAllowed(from, 'cancelled', 'cash')).toBe(true);
    });
  });

  describe('the illegal transitions that matter most', () => {
    it('cannot skip straight from assigned to completed', () => {
      expect(isTransitionAllowed('assigned', 'completed', 'cash')).toBe(false);
    });

    it('cannot complete a job that was never started', () => {
      expect(isTransitionAllowed('arrived', 'completed', 'cash')).toBe(false);
    });

    it('cannot re-start a job already under way', () => {
      expect(isTransitionAllowed('started', 'started', 'cash')).toBe(false);
    });

    it('cannot go backwards from started to arrived', () => {
      expect(isTransitionAllowed('started', 'arrived', 'cash')).toBe(false);
    });
  });

  describe('the whole matrix', () => {
    it('permits exactly the pairs in ALLOWED_TRANSITIONS, and no others', () => {
      for (const [from, to] of ALL_PAIRS) {
        const listed = ALLOWED_TRANSITIONS[from].includes(to);
        const cash = isTransitionAllowed(from, to, 'cash');
        const online = isTransitionAllowed(from, to, 'online');

        // A pair not in the table is illegal in both modes, always.
        if (!listed) {
          expect(cash).toBe(false);
          expect(online).toBe(false);
        } else {
          // A listed pair is legal in at least one mode — the only pairs
          // legal in neither would be dead entries in the table.
          expect(cash || online).toBe(true);
        }
      }
    });

    it('has no self-transitions', () => {
      for (const status of BOOKING_STATUSES) {
        expect(ALLOWED_TRANSITIONS[status]).not.toContain(status);
      }
    });
  });
});

describe('cancellation windows', () => {
  it.each([
    ['created', 'A'],
    ['awaiting_payment', 'A'],
    ['assigning', 'B'],
    ['assigned', 'C'],
    ['en_route', 'D'],
    ['arrived', 'D'],
    ['started', 'E'],
    ['completed', 'F'],
  ] as Array<[BookingStatus, string]>)(
    'puts %s in window %s',
    (status, expected) => {
      expect(cancellationWindowFor(status)).toBe(expected);
    },
  );

  it('gives an already-cancelled booking no window at all', () => {
    expect(cancellationWindowFor('cancelled')).toBeNull();
  });

  it('charges a fee in window D only', () => {
    expect(windowChargesFee('D')).toBe(true);
    for (const window of ['A', 'B', 'C', 'E', 'F'] as const) {
      expect(windowChargesFee(window)).toBe(false);
    }
  });

  it('routes window E to a human — a partial refund is not a formula', () => {
    expect(windowRequiresOps('E')).toBe(true);
    for (const window of ['A', 'B', 'C', 'D', 'F'] as const) {
      expect(windowRequiresOps(window)).toBe(false);
    }
  });
});
