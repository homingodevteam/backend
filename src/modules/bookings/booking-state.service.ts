import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Booking, Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  ActorType,
  BookingStatus,
  PaymentMode,
  TransitionCoordinates,
} from './booking.types';
import { isTransitionAllowed } from './booking.types';

export interface TransitionInput {
  bookingId: string;
  to: BookingStatus;
  actorType: ActorType;
  actorId: string;
  coordinates?: TransitionCoordinates;
  /** Columns to write in the same statement as the status change. */
  data?: Prisma.BookingUpdateInput;
  /**
   * Optimistic guard: refuse unless the booking is still in one of these.
   * Prevents a retried request from replaying a transition that already ran.
   */
  expectedFrom?: BookingStatus[];
}

/**
 * The single door every status change goes through.
 *
 * Two things have to be true at once and neither is optional:
 *
 * 1. Only the transitions in `ALLOWED_TRANSITIONS` may happen, and the fork
 *    out of `created` depends on payment mode.
 * 2. Every transition leaves a `BookingStatusEvent` carrying actor, timestamp
 *    and coordinates — **written in the same transaction as the status
 *    change**. If the two could diverge, the audit trail would sometimes
 *    disagree with the booking, and the trail is the only evidence a dispute
 *    has (US-4.24).
 *
 * Nothing else in this module writes `booking.status`.
 */
@Injectable()
export class BookingStateService {
  constructor(private readonly prisma: PrismaService) {}

  async transition(input: TransitionInput): Promise<Booking> {
    const {
      bookingId,
      to,
      actorType,
      actorId,
      coordinates,
      data = {},
      expectedFrom,
    } = input;

    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw apiError('Booking not found', HttpStatus.NOT_FOUND);

      const from = booking.status as BookingStatus;

      if (expectedFrom && !expectedFrom.includes(from)) {
        throw apiError(
          `This booking is ${from}, so that action no longer applies`,
          HttpStatus.CONFLICT,
          [
            {
              field: 'status',
              message: `Expected one of: ${expectedFrom.join(', ')}`,
              code: 'BOOKING_STATE_MOVED',
            },
          ],
        );
      }

      if (!isTransitionAllowed(from, to, booking.paymentMode as PaymentMode)) {
        throw apiError(
          `A booking cannot go from ${from} to ${to}`,
          HttpStatus.CONFLICT,
          [
            {
              field: 'status',
              message: this.explain(
                from,
                to,
                booking.paymentMode as PaymentMode,
              ),
              code: 'ILLEGAL_TRANSITION',
            },
          ],
        );
      }

      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: { ...data, status: to },
      });

      await tx.bookingStatusEvent.create({
        data: {
          bookingId,
          status: to,
          actorType,
          actorId,
          lat: coordinates?.lat ?? null,
          lng: coordinates?.lng ?? null,
        },
      });

      return updated;
    });
  }

  /**
   * Records something that happened without moving the booking — a failed OTP
   * attempt, a photo upload. Same append-only log, so the timeline a dispute
   * is reconstructed from has no holes in it.
   */
  async recordEvent(
    bookingId: string,
    status: string,
    actorType: ActorType,
    actorId: string,
    coordinates?: TransitionCoordinates,
  ): Promise<void> {
    await this.prisma.bookingStatusEvent.create({
      data: {
        bookingId,
        status,
        actorType,
        actorId,
        lat: coordinates?.lat ?? null,
        lng: coordinates?.lng ?? null,
      },
    });
  }

  /** A sentence a support agent can act on, not just a rejection. */
  private explain(
    from: BookingStatus,
    to: BookingStatus,
    paymentMode: PaymentMode,
  ): string {
    if (from === 'created' && to === 'assigning' && paymentMode === 'online') {
      return 'An online booking must be paid before it can be dispatched';
    }
    if (
      from === 'created' &&
      to === 'awaiting_payment' &&
      paymentMode === 'cash'
    ) {
      return 'A cash booking is never awaiting payment — money moves at the door';
    }
    if (from === 'completed') {
      return 'A completed job cannot be changed. Raise a dispute instead';
    }
    if (from === 'cancelled') {
      return 'This booking was already cancelled';
    }
    return `${from} → ${to} is not a legal transition`;
  }
}
