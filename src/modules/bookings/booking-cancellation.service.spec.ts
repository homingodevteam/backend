import { HttpException, HttpStatus } from '@nestjs/common';
import { BookingCancellationService } from './booking-cancellation.service';

function buildDeps() {
  const state = {
    transition: jest
      .fn()
      .mockImplementation((input: { data?: unknown }) =>
        Promise.resolve({ id: 'booking-1', ...(input.data as object) }),
      ),
  };
  const bookings = { getOwnedBooking: jest.fn(), getByIdOrFail: jest.fn() };
  const settings = {
    getNumber: jest.fn().mockResolvedValue(0),
  };
  const dispatch = { closeAssignment: jest.fn() };
  const payments = { initiateRefund: jest.fn() };
  return { state, bookings, settings, dispatch, payments };
}

function buildService(
  deps: ReturnType<typeof buildDeps>,
): BookingCancellationService {
  return new BookingCancellationService(
    deps.state as never,
    deps.bookings as never,
    deps.settings as never,
    deps.dispatch as never,
    deps.payments as never,
  );
}

async function captureStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

function bookingIn(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'booking-1',
    customerId: 'cust-1',
    proId: status === 'created' ? null : 'pro-1',
    status,
    flatPrice: '1000.00',
    paymentStatus: 'paid',
    assignmentOutcome: null,
    ...overrides,
  };
}

describe('BookingCancellationService', () => {
  describe('who may cancel', () => {
    it('stops a customer cancelling a job already under way — window E is a human call', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('started'));
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.cancelAsCustomer('cust-1', 'booking-1', 'changed my mind'),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.state.transition).not.toHaveBeenCalled();
    });

    it('lets a customer cancel while the Pro is on the way', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('en_route'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('en_route'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'no longer needed');

      expect(deps.state.transition).toHaveBeenCalled();
    });

    it('lets ops reach window E, which the customer cannot', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('started'));
      const service = buildService(deps);

      await service.cancelAsOps(
        'admin-1',
        'booking-1',
        'work is unsafe',
        '400.00',
      );

      expect(deps.state.transition).toHaveBeenCalled();
    });

    it('refuses to cancel a completed job — that is a dispute, not a cancellation', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('completed'));
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.cancelAsOps('admin-1', 'booking-1', 'customer complained'),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    it('refuses to cancel twice', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('cancelled'));
      const service = buildService(deps);

      await expect(
        captureStatus(service.cancelAsOps('admin-1', 'booking-1', 'again')),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });
  });

  describe('the fee', () => {
    it('charges nothing in windows A–C', async () => {
      const deps = buildDeps();
      deps.settings.getNumber.mockResolvedValue(100);
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('assigned'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('assigned'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'plans changed');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('0');
    });

    it('charges the configured fee in window D', async () => {
      const deps = buildDeps();
      deps.settings.getNumber.mockResolvedValue(100);
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('arrived'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('arrived'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'not needed');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string; refundedAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('100.00');
      expect(call.data.refundedAmount).toBe('900.00');
    });

    it('never charges a fee when the platform is the party that failed — US-4.22', async () => {
      const deps = buildDeps();
      deps.settings.getNumber.mockResolvedValue(100);
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('arrived'));
      const service = buildService(deps);

      await service.cancelAsSystem('booking-1', 'no Pro could be found');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string; refundedAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('0');
      expect(call.data.refundedAmount).toBe('1000.00');
    });

    it('does not charge an ops cancellation in window D either', async () => {
      const deps = buildDeps();
      deps.settings.getNumber.mockResolvedValue(100);
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('en_route'));
      const service = buildService(deps);

      await service.cancelAsOps('admin-1', 'booking-1', 'safety incident');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('0');
    });
  });

  describe('the refund', () => {
    it('refunds nothing in window A — nothing was ever charged', async () => {
      const deps = buildDeps();
      const unpaid = bookingIn('created', { paymentStatus: 'unpaid' });
      deps.bookings.getOwnedBooking.mockResolvedValue(unpaid);
      deps.bookings.getByIdOrFail.mockResolvedValue(unpaid);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'mistake');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { refundedAmount: string } }],
      ];
      expect(call.data.refundedAmount).toBe('0');
      expect(deps.payments.initiateRefund).not.toHaveBeenCalled();
    });

    it('refunds in full in window B', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('assigning'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('assigning'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'changed plans');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { refundedAmount: string } }],
      ];
      expect(call.data.refundedAmount).toBe('1000.00');
    });

    it('uses the ops figure in window E and never computes one', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('started'));
      const service = buildService(deps);

      await service.cancelAsOps('admin-1', 'booking-1', 'half done', '350.00');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { refundedAmount: string } }],
      ];
      expect(call.data.refundedAmount).toBe('350.00');
    });

    it('refunds nothing in window E when ops names no amount', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('started'));
      const service = buildService(deps);

      await service.cancelAsOps('admin-1', 'booking-1', 'customer at fault');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { refundedAmount: string } }],
      ];
      expect(call.data.refundedAmount).toBe('0');
    });
  });

  describe('releasing the Pro', () => {
    it('closes the assignment from window C onward', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('en_route'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('en_route'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'not needed');

      // The Pro is physically driving there — every second of delay is a
      // wasted journey.
      expect(deps.dispatch.closeAssignment).toHaveBeenCalledWith(
        'booking-1',
        'not needed',
      );
    });

    it('has no assignment to close in windows A and B', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('assigning'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('assigning'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'changed plans');

      expect(deps.dispatch.closeAssignment).not.toHaveBeenCalled();
    });
  });

  describe('describeWindow', () => {
    it('tells ops which window a booking is in and what it costs', async () => {
      const deps = buildDeps();
      deps.settings.getNumber.mockResolvedValue(150);
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('arrived'));
      const service = buildService(deps);

      await expect(service.describeWindow('booking-1')).resolves.toEqual({
        window: 'D',
        chargesFee: true,
        requiresOps: false,
        feeAmount: '150.00',
      });
    });
  });
});
