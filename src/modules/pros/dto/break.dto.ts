import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * The shortest and longest break a Pro may take in one go.
 *
 * A cap exists because this flag makes them undispatchable and nothing else
 * clears it — an eight-hour "break" is going off duty, which is an admin
 * decision (US-6.13). Thirty minutes is the default the app offers; the range
 * is what the endpoint will accept.
 */
export const MIN_BREAK_MINUTES = 5;
export const MAX_BREAK_MINUTES = 60;
export const DEFAULT_BREAK_MINUTES = 30;

/** How far ahead a break may be booked. Beyond a day it is a roster. */
export const MAX_SCHEDULE_AHEAD_HOURS = 24;

export class StartBreakDto {
  @ApiPropertyOptional({
    description: `How long the break lasts. Defaults to ${DEFAULT_BREAK_MINUTES}.`,
    minimum: MIN_BREAK_MINUTES,
    maximum: MAX_BREAK_MINUTES,
    default: DEFAULT_BREAK_MINUTES,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_BREAK_MINUTES)
  @Max(MAX_BREAK_MINUTES)
  minutes?: number;
}

/**
 * A break booked for later.
 *
 * Both ends are given rather than a start plus a duration: the client already
 * knows the window it is offering, and a duration would have to be re-derived
 * on both sides to answer "does this overlap that".
 */
export class ScheduleBreakDto {
  @ApiProperty({ format: 'date-time' })
  @IsDateString({ strict: true })
  startAt: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString({ strict: true })
  endAt: string;
}

/**
 * What every break route answers with — the Pro's whole break state.
 *
 * One shape for start, end, schedule, cancel and read, so the client has a
 * single thing to store and no route returns a partial view another one
 * contradicts.
 */
export class BreakStatusDto {
  @ApiProperty({
    description:
      'Whether a break is running right now. Derived from breakEndsAt vs now — never stored.',
  })
  isOnBreak: boolean;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  breakStartedAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    format: 'date-time',
    description: 'When the running break ends. Null when not on one.',
  })
  breakEndsAt: Date | null;

  @ApiProperty({
    description:
      'Seconds left on the running break, floored at 0. What the timer counts down.',
  })
  secondsRemaining: number;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  scheduledBreakStartAt: Date | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  scheduledBreakEndAt: Date | null;
}
