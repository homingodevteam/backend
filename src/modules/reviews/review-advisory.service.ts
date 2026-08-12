import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ADVISORY_RECENT_LIMIT,
  emptyTagCounts,
  readTags,
} from './reviews.types';
import type { CustomerAdvisoryDto } from './dto/review.dto';

/**
 * What the next Pro dispatched to a household is told about it — feature 13.
 *
 * ## Aggregated, tag-only, and nobody is named
 *
 * A Pro walking into a house learns "three people could not get in", not who
 * said it and not in whose words. That is not politeness: there is no free
 * text in this direction to leak, no prior Pro is identified, and the note is
 * a count rather than an accusation. A Pro who reads "difficult, argued about
 * the bill, see previous" arrives having already decided how the visit goes.
 *
 * ## And it reaches exactly one audience
 *
 * The assigned Pro, on their own job card, plus ops. Never the customer, and
 * never any customer-facing serialiser — `reviews.e2e-spec.ts` walks the live
 * HTTP surface and fails if a `reviewerType: 'pro'` row appears on a route a
 * customer can call.
 *
 * ## It drives nothing
 *
 * Not dispatch, not pricing, not eligibility. A household quietly losing
 * service from a signal it cannot see, with no notice and no appeal, is a
 * worse outcome than a Pro occasionally walking into a difficult job
 * forewarned. Acting on a pattern is a human decision, taken on the ops screen
 * with a name attached.
 */
@Injectable()
export class ReviewAdvisoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The advisory for the customer on a booking this Pro is assigned to. */
  async forBooking(
    proId: string,
    bookingId: string,
  ): Promise<CustomerAdvisoryDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { proId: true, customerId: true },
    });
    if (!booking || booking.proId !== proId) {
      throw new NotFoundException('Assigned booking not found');
    }
    return this.forCustomer(booking.customerId);
  }

  /**
   * Every Pro-authored review of one household.
   *
   * Reads the counters for the average rather than summing rows, so this
   * agrees with the ops screen and with the nightly rebuild by construction.
   * The tag counts do need the rows — there is no counter for a tag, and
   * adding five would be five more things to keep honest.
   */
  async forCustomer(customerId: string): Promise<CustomerAdvisoryDto> {
    const [customer, rows] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { ratingSum: true, ratingCount: true },
      }),
      this.prisma.review.findMany({
        where: { customerId, reviewerType: 'pro' },
        select: { tags: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (!customer) throw new NotFoundException('Customer not found');

    const tagCounts = emptyTagCounts('pro');
    for (const row of rows) {
      for (const tag of readTags(row.tags, 'pro')) tagCounts[tag] += 1;
    }

    return {
      ratingAverage:
        customer.ratingCount === 0
          ? null
          : customer.ratingSum / customer.ratingCount,
      ratingCount: customer.ratingCount,
      tagCounts,
      recentNotes: rows.slice(0, ADVISORY_RECENT_LIMIT).map((row) => ({
        occurredAt: row.createdAt,
        tags: readTags(row.tags, 'pro'),
      })),
    };
  }
}
