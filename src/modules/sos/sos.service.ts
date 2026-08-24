import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma, SosAlert } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { apiError } from '../../common/utils';
import type {
  AcknowledgeSosAlertDto,
  CreateSosAlertDto,
  ResolveSosAlertDto,
  SosAlertDto,
  StandDownSosAlertDto,
} from './dto/sos.dto';

/**
 * Module 11 · Safety.
 *
 * ---------------------------------------------------------------------------
 * AN ALARM IS WRITTEN FIRST AND VALIDATED SECOND
 * ---------------------------------------------------------------------------
 * Every other write path in this codebase checks its preconditions and refuses
 * the row if they fail. This one does not, and the inversion is deliberate.
 *
 * The failure mode of a strict SOS endpoint is that somebody in trouble gets a
 * 404 because the booking id they sent had been cancelled thirty seconds
 * earlier, or a 400 because a GPS fix came back malformed indoors. There is no
 * recoverable version of that. So a bad `bookingId` is dropped to null and the
 * alarm still lands; a missing fix is stored as missing; an unknown service
 * title is stored as sent. The only thing that can stop a row being written is
 * the database being unreachable.
 *
 * ---------------------------------------------------------------------------
 * THE RETRY IS PART OF THE FEATURE, NOT AN OPTIMISATION
 * ---------------------------------------------------------------------------
 * The app queues alarms that could not be sent and drains the queue whenever
 * it next has a connection — possibly more than once, possibly after a
 * restart. `clientAlertId` is what makes that safe: the second arrival of the
 * same press returns the first row with 200. Answering a retry with a conflict
 * would either raise two incidents for one emergency or teach the client to
 * stop retrying, and both are worse than a duplicate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE YET
 * ---------------------------------------------------------------------------
 * There is no paging integration. This backend has no push transport — the
 * Firebase wrapper is auth-only — so "ops is alerted immediately" currently
 * means the row is written and `GET /admin/sos/alerts` returns it at the top
 * of the queue, unacknowledged, ahead of everything else. A console polling
 * that endpoint is how a human finds out. The moment a transport exists, it
 * is called from `raise()` below and nothing else in this file changes.
 */
@Injectable()
export class SosService {
  private readonly logger = new Logger(SosService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // The customer's side
  // ------------------------------------------------------------------

  /**
   * Raise one.
   *
   * Returns the original row on a repeated `clientAlertId`, and the controller
   * reports that as a create either way — the client cannot act on the
   * difference and must not be encouraged to try.
   */
  async raise(
    customerId: string,
    dto: CreateSosAlertDto,
  ): Promise<SosAlertDto> {
    if (dto.clientAlertId) {
      const existing = await this.prisma.sosAlert.findUnique({
        where: { clientAlertId: dto.clientAlertId },
      });
      if (existing) {
        /*
         * Belt and braces: a key is scoped to the device that minted it, so a
         * collision across customers means a client bug or a forged id. The
         * safe answer is to raise a fresh alarm rather than hand back somebody
         * else's incident.
         */
        if (existing.customerId === customerId) {
          return this.toDto(existing);
        }
        this.logger.warn(
          `clientAlertId collision across customers (${dto.clientAlertId}) - raising a new alert`,
        );
      }
    }

    const bookingId = await this.resolveBookingId(customerId, dto.bookingId);
    const contactPhone = await this.lookupPhone(customerId);

    const data: Prisma.SosAlertUncheckedCreateInput = {
      customerId,
      bookingId,
      status: 'active',
      raisedAt: this.parseDate(dto.raisedAt) ?? new Date(),
      lat: dto.lat ?? null,
      lng: dto.lng ?? null,
      locationAccuracyM: dto.locationAccuracyM ?? null,
      locationAt: this.parseDate(dto.locationAt),
      addressText: dto.addressText ?? null,
      serviceTitle: dto.serviceTitle ?? null,
      proName: dto.proName ?? null,
      contactPhone,
      clientAlertId: dto.clientAlertId ?? null,
      /* Prisma leaves `updatedAt` NOT NULL with no database default on this
         schema, so every insert states it. */
      updatedAt: new Date(),
    };

    let alert: SosAlert;
    try {
      alert = await this.prisma.sosAlert.create({ data });
    } catch (error) {
      /*
       * Two drains of the same queued alarm can race past the lookup above and
       * both insert. The unique index catches the second, and the row the
       * first one wrote is the right answer.
       */
      if (this.isUniqueViolation(error) && dto.clientAlertId) {
        const raced = await this.prisma.sosAlert.findUnique({
          where: { clientAlertId: dto.clientAlertId },
        });
        if (raced) {
          return this.toDto(raced);
        }
      }
      throw error;
    }

    /*
     * Loud on purpose, and the highest-severity line this service writes.
     * Until there is a pager, the log is the second place a human can find an
     * incident, and an alarm that only exists in a table nobody is watching is
     * not an alarm.
     */
    this.logger.error(
      `SOS RAISED - alert=${alert.id} customer=${customerId} ` +
        `booking=${bookingId ?? 'none'} ` +
        `at=${alert.lat ?? '?'},${alert.lng ?? '?'} ` +
        `raisedAt=${alert.raisedAt.toISOString()}`,
    );

    return this.toDto(alert);
  }

  /**
   * "I am safe."
   *
   * Idempotent, and takes no reason. Standing down an alarm that was already
   * stood down is a double tap, not an error worth a 409.
   */
  async standDown(
    customerId: string,
    alertId: string,
    dto: StandDownSosAlertDto,
  ): Promise<SosAlertDto> {
    const alert = await this.prisma.sosAlert.findUnique({
      where: { id: alertId },
    });

    if (!alert || alert.customerId !== customerId) {
      throw apiError('That alert could not be found', HttpStatus.NOT_FOUND);
    }

    if (alert.status !== 'active') {
      return this.toDto(alert);
    }

    const updated = await this.prisma.sosAlert.update({
      where: { id: alertId },
      data: {
        status: dto.status ?? 'false_alarm',
        resolvedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    this.logger.warn(
      `SOS stood down by customer - alert=${alertId} status=${updated.status}`,
    );

    return this.toDto(updated);
  }

  /**
   * The customer's own alarms, newest first.
   *
   * Exists so the app can reconcile after a restart: a device that queued an
   * alarm offline and was killed before draining needs to know whether the
   * press ever landed.
   */
  async listMine(customerId: string): Promise<SosAlertDto[]> {
    const rows = await this.prisma.sosAlert.findMany({
      where: { customerId },
      orderBy: { raisedAt: 'desc' },
      take: 20,
    });
    return rows.map((row) => this.toDto(row));
  }

  /** The one still running, if any - what the app reopens onto. */
  async findActive(customerId: string): Promise<SosAlertDto | null> {
    const row = await this.prisma.sosAlert.findFirst({
      where: { customerId, status: 'active' },
      orderBy: { raisedAt: 'desc' },
    });
    return row ? this.toDto(row) : null;
  }

  // ------------------------------------------------------------------
  // The console's side
  // ------------------------------------------------------------------

  /**
   * The queue, ordered the way a dispatcher needs it rather than by time.
   *
   * Active first, and within active the oldest press first — the person who
   * has been waiting longest is the one nobody has reached yet. Sorting newest
   * to the top, which is the default everywhere else in this codebase, would
   * bury exactly that person.
   */
  async listForOps(params: {
    status?: string;
    limit?: number;
  }): Promise<SosAlertDto[]> {
    const rows = await this.prisma.sosAlert.findMany({
      where: params.status ? { status: params.status } : undefined,
      orderBy: { raisedAt: 'asc' },
      take: Math.min(params.limit ?? 100, 200),
    });

    /*
     * Pinned here rather than left to the database: 'active' sorts before
     * 'closed' and 'false_alarm' alphabetically by luck, not by intent, and a
     * renamed status must not be able to silently reshuffle the queue.
     */
    const rank = (status: string): number =>
      status === 'active' ? 0 : status === 'closed' ? 1 : 2;

    return rows
      .sort(
        (a, b) =>
          rank(a.status) - rank(b.status) ||
          a.raisedAt.getTime() - b.raisedAt.getTime(),
      )
      .map((row) => this.toDto(row));
  }

  async getForOps(alertId: string): Promise<SosAlertDto> {
    const alert = await this.prisma.sosAlert.findUnique({
      where: { id: alertId },
    });
    if (!alert) {
      throw apiError('That alert could not be found', HttpStatus.NOT_FOUND);
    }
    return this.toDto(alert);
  }

  /**
   * A human has it.
   *
   * The first write that matters to the customer, because "we have it" is the
   * only reassurance worth showing on that screen. Stamped once — a second
   * responder opening the same alert does not reset the clock on how long it
   * took somebody to pick it up.
   */
  async acknowledge(
    adminId: string,
    alertId: string,
    dto: AcknowledgeSosAlertDto,
  ): Promise<SosAlertDto> {
    const alert = await this.prisma.sosAlert.findUnique({
      where: { id: alertId },
    });
    if (!alert) {
      throw apiError('That alert could not be found', HttpStatus.NOT_FOUND);
    }
    if (alert.acknowledgedAt) {
      return this.toDto(alert);
    }

    const updated = await this.prisma.sosAlert.update({
      where: { id: alertId },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedByAdminId: adminId,
        resolutionNotes: dto.notes ?? alert.resolutionNotes,
        updatedAt: new Date(),
      },
    });
    return this.toDto(updated);
  }

  /**
   * Closing it out.
   *
   * `resolutionNotes` is required by the DTO. An incident closed with no
   * account of what happened cannot be reviewed later, and a cluster of them
   * in one area is a supply problem nobody will ever spot.
   */
  async resolve(
    adminId: string,
    alertId: string,
    dto: ResolveSosAlertDto,
  ): Promise<SosAlertDto> {
    const alert = await this.prisma.sosAlert.findUnique({
      where: { id: alertId },
    });
    if (!alert) {
      throw apiError('That alert could not be found', HttpStatus.NOT_FOUND);
    }

    const now = new Date();
    const updated = await this.prisma.sosAlert.update({
      where: { id: alertId },
      data: {
        status: dto.status ?? 'closed',
        resolutionNotes: dto.resolutionNotes,
        resolvedAt: now,
        // Closing without having acknowledged still records who was there.
        acknowledgedAt: alert.acknowledgedAt ?? now,
        acknowledgedByAdminId: alert.acknowledgedByAdminId ?? adminId,
        updatedAt: now,
      },
    });
    return this.toDto(updated);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Keeps a booking id only if it is real and belongs to this customer.
   *
   * Anything else becomes null rather than an error — see the file note. A
   * mis-sent booking reference must cost the alarm its context, never its
   * existence.
   */
  private async resolveBookingId(
    customerId: string,
    bookingId?: string,
  ): Promise<string | null> {
    if (!bookingId) {
      return null;
    }
    try {
      const booking = await this.prisma.booking.findFirst({
        where: { id: bookingId, customerId },
        select: { id: true },
      });
      if (!booking) {
        this.logger.warn(
          `SOS referenced booking ${bookingId} which is not this customer's - storing without it`,
        );
      }
      return booking?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Best effort — a missing phone must not cost the alarm. */
  private async lookupPhone(customerId: string): Promise<string | null> {
    try {
      const customer = await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { phone: true },
      });
      return customer?.phone ?? null;
    } catch {
      return null;
    }
  }

  /** A device clock that sent nonsense must not throw away the alarm. */
  private parseDate(value?: string | null): Date | null {
    if (!value) {
      return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    );
  }

  private toDto(alert: SosAlert): SosAlertDto {
    return {
      id: alert.id,
      status: alert.status as SosAlertDto['status'],
      raisedAt: alert.raisedAt.toISOString(),
      createdAt: alert.createdAt.toISOString(),
      bookingId: alert.bookingId,
      lat: alert.lat,
      lng: alert.lng,
      locationAccuracyM: alert.locationAccuracyM,
      locationAt: alert.locationAt ? alert.locationAt.toISOString() : null,
      addressText: alert.addressText,
      serviceTitle: alert.serviceTitle,
      proName: alert.proName,
      acknowledgedAt: alert.acknowledgedAt
        ? alert.acknowledgedAt.toISOString()
        : null,
      resolvedAt: alert.resolvedAt ? alert.resolvedAt.toISOString() : null,
      resolutionNotes: alert.resolutionNotes,
      acknowledged: !!alert.acknowledgedAt,
    };
  }
}
