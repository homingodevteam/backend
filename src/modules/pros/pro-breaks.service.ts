import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Pro } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BreakStatusDto,
  DEFAULT_BREAK_MINUTES,
  MAX_BREAK_MINUTES,
  MAX_SCHEDULE_AHEAD_HOURS,
  MIN_BREAK_MINUTES,
  ScheduleBreakDto,
  StartBreakDto,
} from './dto/break.dto';

/**
 * A Pro pausing dispatch for themselves.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `isAvailable`
 * ---------------------------------------------------------------------------
 * `Pro.isAvailable` is the admin roster flag — US-6.12 is explicit that the
 * Pro cannot set it and there is no route that lets them. Writing a break
 * through it would break that in both directions: a Pro could switch
 * themselves ON by ending a break they were never rostered for, and an admin
 * un-rostering someone mid-break would be silently undone thirty minutes
 * later.
 *
 * So a break is its own pair of columns, and dispatch reads BOTH gates. The
 * admin decides whether this Pro works today; the Pro decides whether they
 * are working in the next half hour. Neither can overwrite the other.
 *
 * ---------------------------------------------------------------------------
 * A TIMESTAMP, NOT A FLAG, AND NOTHING RUNS TO END IT
 * ---------------------------------------------------------------------------
 * `breakEndsAt` is when the break is over, so it expires on its own. There is
 * no scheduler to end breaks and no job that can fall behind and leave a Pro
 * stranded off-duty — every read compares it to `now()`, so a Pro whose app
 * was killed mid-break is back in the dispatch pool the moment the clock
 * passes it.
 *
 * ---------------------------------------------------------------------------
 * WHY A BREAK CAN BE BOOKED AHEAD
 * ---------------------------------------------------------------------------
 * Dispatch assigns work with a `slotStartAt` in the future. A Pro who waits
 * until 13:00 to tap "break" has already been handed the 13:15 job — the
 * break stops them being ranked from that moment, but it cannot un-assign
 * what they were given ten minutes ago. Declaring the window in advance is
 * the only thing that actually keeps it clear.
 */
@Injectable()
export class ProBreaksService {
  constructor(private readonly prisma: PrismaService) {}

  private async getPro(proId: string): Promise<Pro> {
    const pro = await this.prisma.pro.findUnique({ where: { id: proId } });
    if (!pro) throw new NotFoundException('Pro not found');
    return pro;
  }

  /**
   * The break state, as every route returns it.
   *
   * `isOnBreak` and `secondsRemaining` are derived here rather than stored:
   * a break ends by the clock passing it, so anything persisted would be
   * wrong from that instant until something wrote to it.
   */
  static toStatus(pro: Pro, now: Date = new Date()): BreakStatusDto {
    const endsAt = pro.breakEndsAt;
    const isOnBreak = Boolean(endsAt && endsAt.getTime() > now.getTime());

    return {
      isOnBreak,
      // Null once the break is over, so a stale timestamp never reads as a
      // break that is still running.
      breakStartedAt: isOnBreak ? pro.breakStartedAt : null,
      breakEndsAt: isOnBreak ? endsAt : null,
      secondsRemaining:
        isOnBreak && endsAt
          ? Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000))
          : 0,
      scheduledBreakStartAt: pro.scheduledBreakStartAt,
      scheduledBreakEndAt: pro.scheduledBreakEndAt,
    };
  }

  async status(proId: string): Promise<BreakStatusDto> {
    return ProBreaksService.toStatus(await this.getPro(proId));
  }

  /**
   * Start a break now.
   *
   * Refused while one is already running rather than silently extending it:
   * a double tap would otherwise turn a 30-minute break into an hour, and the
   * Pro has no way to see that it happened. Ending and restarting is the
   * explicit way to do that, and it is two deliberate taps.
   */
  async start(proId: string, dto: StartBreakDto): Promise<BreakStatusDto> {
    const pro = await this.getPro(proId);
    const now = new Date();

    if (pro.breakEndsAt && pro.breakEndsAt.getTime() > now.getTime()) {
      throw apiError(
        'You are already on a break. End it before starting another.',
        HttpStatus.CONFLICT,
      );
    }

    /*
     * A Pro who is not rostered has nothing to pause. Refusing here rather
     * than writing the columns anyway keeps "on a break" meaning one thing —
     * without it, an off-duty Pro could hold a running timer that changes
     * nothing about whether they receive work.
     */
    if (!pro.isAvailable) {
      throw apiError(
        'You are off duty, so there is no dispatch to pause.',
        HttpStatus.CONFLICT,
      );
    }

    const minutes = dto.minutes ?? DEFAULT_BREAK_MINUTES;
    const endsAt = new Date(now.getTime() + minutes * 60_000);

    const updated = await this.prisma.pro.update({
      where: { id: proId },
      data: { breakStartedAt: now, breakEndsAt: endsAt },
    });

    return ProBreaksService.toStatus(updated, now);
  }

  /**
   * End a break early.
   *
   * Clears both columns rather than setting `breakEndsAt` to now — the
   * derived `isOnBreak` would agree either way, but a null is unambiguous to
   * anyone reading the row, and `breakStartedAt` left behind would describe a
   * break that is not happening.
   *
   * Deliberately NOT an error when no break is running. This is the "get me
   * back to work" button; failing it because the timer had already elapsed
   * would be refusing to do something that is already true.
   */
  async end(proId: string): Promise<BreakStatusDto> {
    await this.getPro(proId);

    const updated = await this.prisma.pro.update({
      where: { id: proId },
      data: { breakStartedAt: null, breakEndsAt: null },
    });

    return ProBreaksService.toStatus(updated);
  }

  /**
   * Book a break for later.
   *
   * One scheduled window at a time. A list would need its own table and an
   * overlap check across rows, and the thing being asked for is "keep my
   * lunch clear" — the second window is a roster, which this system does not
   * have (US-6.12).
   */
  async schedule(
    proId: string,
    dto: ScheduleBreakDto,
  ): Promise<BreakStatusDto> {
    await this.getPro(proId);

    const now = new Date();
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    if (endAt.getTime() <= startAt.getTime()) {
      throw apiError(
        'The break has to end after it starts.',
        HttpStatus.BAD_REQUEST,
      );
    }

    /*
     * A window in the past cannot keep anything clear — dispatch has already
     * been through it. Caught here rather than accepted and ignored, because
     * a Pro who books one and sees it stored believes their afternoon is
     * protected.
     */
    if (endAt.getTime() <= now.getTime()) {
      throw apiError(
        'That break window has already passed.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const minutes = Math.round((endAt.getTime() - startAt.getTime()) / 60_000);

    if (minutes < MIN_BREAK_MINUTES || minutes > MAX_BREAK_MINUTES) {
      throw apiError(
        `A break has to be between ${MIN_BREAK_MINUTES} and ${MAX_BREAK_MINUTES} minutes.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const aheadHours = (startAt.getTime() - now.getTime()) / (60 * 60 * 1000);

    if (aheadHours > MAX_SCHEDULE_AHEAD_HOURS) {
      throw apiError(
        `A break can only be booked up to ${MAX_SCHEDULE_AHEAD_HOURS} hours ahead.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.pro.update({
      where: { id: proId },
      data: { scheduledBreakStartAt: startAt, scheduledBreakEndAt: endAt },
    });

    return ProBreaksService.toStatus(updated, now);
  }

  /** Drop the booked window. The running break, if any, is untouched. */
  async cancelScheduled(proId: string): Promise<BreakStatusDto> {
    await this.getPro(proId);

    const updated = await this.prisma.pro.update({
      where: { id: proId },
      data: { scheduledBreakStartAt: null, scheduledBreakEndAt: null },
    });

    return ProBreaksService.toStatus(updated);
  }
}
