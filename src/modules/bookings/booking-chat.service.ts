import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { ChatMessage } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BookingsService } from './bookings.service';
import { PlatformSettingsService } from './platform-settings.service';

/**
 * Customer ↔ assigned Pro, scoped to one booking.
 *
 * Two properties matter more than the feature itself:
 *
 * - **Neither side ever sees the other's number.** No phone field appears in
 *   any DTO this service returns, which is why the thread exists at all
 *   instead of exchanging contact details.
 * - **The thread outlives the job.** It is dispute evidence (US-4.24), so
 *   reads never close — only writes do.
 */
@Injectable()
export class BookingChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly settings: PlatformSettingsService,
  ) {}

  listForCustomer(
    customerId: string,
    bookingId: string,
  ): Promise<ChatMessage[]> {
    return this.bookings
      .getOwnedBooking(customerId, bookingId)
      .then(() => this.list(bookingId));
  }

  listForPro(proId: string, bookingId: string): Promise<ChatMessage[]> {
    return this.bookings
      .getAssignedBooking(proId, bookingId)
      .then(() => this.list(bookingId));
  }

  /** Ops reads the thread to settle a dispute; it never joins it. */
  list(bookingId: string): Promise<ChatMessage[]> {
    return this.prisma.chatMessage.findMany({
      where: { bookingId },
      orderBy: { sentAt: 'asc' },
    });
  }

  async sendAsCustomer(
    customerId: string,
    bookingId: string,
    body: string,
  ): Promise<ChatMessage> {
    const booking = await this.bookings.getOwnedBooking(customerId, bookingId);
    await this.assertWritable(booking.completedAt, booking.status);
    return this.send(bookingId, 'customer', customerId, body);
  }

  async sendAsPro(
    proId: string,
    bookingId: string,
    body: string,
  ): Promise<ChatMessage> {
    const booking = await this.bookings.getAssignedBooking(proId, bookingId);
    await this.assertWritable(booking.completedAt, booking.status);
    return this.send(bookingId, 'pro', proId, body);
  }

  private send(
    bookingId: string,
    senderType: 'customer' | 'pro',
    senderId: string,
    body: string,
  ): Promise<ChatMessage> {
    return this.prisma.chatMessage.create({
      data: { bookingId, senderType, senderId, body },
    });
  }

  /**
   * Closing the channel is the point: US-4.8 flags that without it the thread
   * "becomes an unmonitored channel between strangers". Enforced here rather
   * than in the client, since a client-side check protects nobody.
   */
  private async assertWritable(
    completedAt: Date | null,
    status: string,
  ): Promise<void> {
    if (status === 'cancelled') {
      throw apiError(
        'This booking was cancelled, so the chat is closed',
        HttpStatus.CONFLICT,
      );
    }
    if (!completedAt) return;

    const hours = await this.settings.getNumber(
      'booking.chatWindowHoursAfterCompletion',
      24,
    );
    const closesAt = completedAt.getTime() + hours * 3_600_000;

    if (Date.now() > closesAt) {
      throw apiError(
        'This chat closed after the job was completed. Contact support if you still need help.',
        HttpStatus.CONFLICT,
        [
          {
            field: 'bookingId',
            message: `Chat closes ${hours}h after completion`,
            code: 'CHAT_WINDOW_CLOSED',
          },
        ],
      );
    }
  }
}
