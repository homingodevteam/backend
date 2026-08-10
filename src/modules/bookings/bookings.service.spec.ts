import { HttpException, HttpStatus } from '@nestjs/common';
import { BookingsService } from './bookings.service';

function buildDeps() {
  const prisma = {
    booking: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ id: 'booking-1', status: 'created', ...data }),
        ),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    bookingStatusEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([{ nextval: 7n }]),
  };
  const state = {
    transition: jest
      .fn()
      .mockImplementation((input: { to: string }) =>
        Promise.resolve({ id: 'booking-1', status: input.to }),
      ),
    recordEvent: jest.fn(),
  };
  const catalog = { assertBookable: jest.fn() };
  const customers = {
    getAddressForCustomer: jest
      .fn()
      .mockResolvedValue({ id: 'addr-1', cityId: 'city-1' }),
    checkServiceability: jest.fn().mockResolvedValue({ serviceable: true }),
  };
  const dispatch = { requestAssignment: jest.fn() };
  const payments = { createOrder: jest.fn() };
  return { prisma, state, catalog, customers, dispatch, payments };
}

function buildService(deps: ReturnType<typeof buildDeps>): BookingsService {
  return new BookingsService(
    deps.prisma as never,
    deps.state as never,
    deps.catalog as never,
    deps.customers as never,
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

const service90min = {
  id: 'svc-1',
  flatPrice: '599.00',
  durationMinutes: 90,
  supportsInstant: true,
  supportsScheduled: true,
  supportsRecurring: false,
};

describe('BookingsService', () => {
  describe('price freezing', () => {
    it('copies the catalogue price onto the booking', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
      });

      const [[call]] = deps.prisma.booking.create.mock.calls as [
        [{ data: { flatPrice: string } }],
      ];
      expect(call.data.flatPrice).toBe('599.00');
    });

    it('derives the slot window from the service duration', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
      });

      const [[call]] = deps.prisma.booking.create.mock.calls as [
        [{ data: { slotStartAt: Date; slotEndAt: Date } }],
      ];
      const minutes =
        (call.data.slotEndAt.getTime() - call.data.slotStartAt.getTime()) /
        60_000;
      expect(minutes).toBe(90);
    });
  });

  describe('the payment-mode fork', () => {
    it('sends a cash booking straight to assigning and asks for dispatch', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
      });

      const transitions = deps.state.transition.mock.calls.map(
        ([call]) => (call as { to: string }).to,
      );
      expect(transitions).toEqual(['assigning']);
      expect(deps.dispatch.requestAssignment).toHaveBeenCalledWith('booking-1');
    });

    it('sends an online booking to awaiting_payment and never to dispatch', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      deps.payments.createOrder.mockResolvedValue({ orderId: 'order-1' });
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'online',
      });

      const transitions = deps.state.transition.mock.calls.map(
        ([call]) => (call as { to: string }).to,
      );
      expect(transitions).toEqual(['awaiting_payment']);
      expect(deps.dispatch.requestAssignment).not.toHaveBeenCalled();
    });
  });

  describe('what is refused', () => {
    it('refuses a booking in a city we do not operate in', async () => {
      const deps = buildDeps();
      deps.customers.checkServiceability.mockResolvedValue({
        serviceable: false,
      });
      const bookings = buildService(deps);

      await expect(
        captureStatus(
          bookings.create('cust-1', {
            serviceId: 'svc-1',
            addressId: 'addr-1',
            paymentMode: 'cash',
          }),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
      // The catalogue is never consulted — serviceability fails first.
      expect(deps.catalog.assertBookable).not.toHaveBeenCalled();
    });

    it('refuses an instant booking of a scheduled-only service', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue({
        ...service90min,
        supportsInstant: false,
      });
      const bookings = buildService(deps);

      await expect(
        captureStatus(
          bookings.create('cust-1', {
            serviceId: 'svc-1',
            addressId: 'addr-1',
            paymentMode: 'cash',
          }),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    it('refuses a slot in the past', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await expect(
        captureStatus(
          bookings.create('cust-1', {
            serviceId: 'svc-1',
            addressId: 'addr-1',
            paymentMode: 'cash',
            slotStartAt: new Date(Date.now() - 60_000),
          }),
        ),
      ).resolves.toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('idempotency', () => {
    it('returns the original booking on a replay instead of creating a second', async () => {
      const deps = buildDeps();
      deps.prisma.bookingStatusEvent.findFirst.mockResolvedValue({
        booking: { id: 'booking-original' },
      });
      const bookings = buildService(deps);

      const result = await bookings.create(
        'cust-1',
        { serviceId: 'svc-1', addressId: 'addr-1', paymentMode: 'cash' },
        'key-123',
      );

      expect(result).toEqual({ id: 'booking-original' });
      expect(deps.prisma.booking.create).not.toHaveBeenCalled();
    });
  });

  describe('rebook', () => {
    it('records the lineage but never pins the original Pro', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        id: 'old-booking',
        customerId: 'cust-1',
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
        proId: 'pro-original',
      });
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      deps.prisma.booking.update.mockResolvedValue({ id: 'booking-1' });
      const bookings = buildService(deps);

      await bookings.rebook('cust-1', 'old-booking');

      const [[call]] = deps.prisma.booking.update.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      // Rotation still applies — a rebook is not a request for the same person.
      expect(call.data).toEqual({ rebookedFromBookingId: 'old-booking' });
      expect(call.data).not.toHaveProperty('proId');
    });
  });

  describe('ownership non-disclosure', () => {
    it('reports someone else’s booking as not found', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        id: 'booking-1',
        customerId: 'someone-else',
      });
      const bookings = buildService(deps);

      await expect(
        captureStatus(bookings.getOwnedBooking('cust-1', 'booking-1')),
      ).resolves.toBe(HttpStatus.NOT_FOUND);
    });

    it('reports a job assigned to another Pro as not found', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        id: 'booking-1',
        proId: 'other-pro',
      });
      const bookings = buildService(deps);

      await expect(
        captureStatus(bookings.getAssignedBooking('pro-1', 'booking-1')),
      ).resolves.toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('booking number', () => {
    it('is human-readable and sequential, not random', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
      });

      const [[call]] = deps.prisma.booking.create.mock.calls as [
        [{ data: { bookingNumber: string } }],
      ];
      expect(call.data.bookingNumber).toMatch(/^HB-\d{4}-000007$/);
    });
  });
});
