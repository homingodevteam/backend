import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { apiError } from '../../common/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

const ACK_EVENT = 'assignment_acknowledged';
const REBUILD_LOCK = 'jobs:pro-counters:rebuild';

@Injectable()
export class ProCountersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProCountersService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('PRO_COUNTER_REBUILD_ENABLED') === 'false') {
      return;
    }
    this.scheduleNextRebuild();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async recordOffer(
    bookingId: string,
    attemptNumber: number,
    proId: string,
    ratingScore?: number,
    offersToday?: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${bookingId}:${attemptNumber}:${proId}`}, 0))`;
      const existing = await tx.assignmentCandidate.findUnique({
        where: {
          bookingId_attemptNumber_proId: { bookingId, attemptNumber, proId },
        },
      });
      if (existing) return;
      await tx.assignmentCandidate.create({
        data: {
          bookingId,
          attemptNumber,
          proId,
          isWinner: true,
          ratingScore,
          offersToday,
        },
      });
      await tx.pro.update({
        where: { id: proId },
        data: { assignmentsOffered: { increment: 1 } },
      });
    });
  }

  async recordAcknowledgement(bookingId: string, proId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ack:${bookingId}`}, 0))`;
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking || booking.proId !== proId) {
        throw new NotFoundException('Assigned booking not found');
      }
      const existing = await tx.bookingStatusEvent.findFirst({
        where: {
          bookingId,
          status: ACK_EVENT,
          actorType: 'pro',
          actorId: proId,
        },
      });
      if (existing) return;
      const now = new Date();
      if (
        booking.assignmentOutcome !== 'pending_ack' ||
        (booking.ackDeadlineAt && booking.ackDeadlineAt < now)
      ) {
        throw apiError(
          'The assignment acknowledgement window has closed',
          HttpStatus.CONFLICT,
        );
      }
      await tx.booking.update({
        where: { id: bookingId },
        data: {
          acknowledgedAt: now,
          assignmentOutcome: 'acknowledged',
        },
      });
      await tx.bookingStatusEvent.create({
        data: {
          bookingId,
          status: ACK_EVENT,
          actorType: 'pro',
          actorId: proId,
          occurredAt: now,
        },
      });
      const pro = await tx.pro.update({
        where: { id: proId },
        data: { assignmentsAcknowledged: { increment: 1 } },
      });
      await tx.pro.update({
        where: { id: proId },
        data: {
          acceptanceRate:
            pro.assignmentsOffered === 0
              ? null
              : pro.assignmentsAcknowledged / pro.assignmentsOffered,
        },
      });
    });
  }

  async recordCompletion(bookingId: string, proId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`complete:${bookingId}`}, 0))`;
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking || booking.proId !== proId) {
        throw new NotFoundException('Assigned booking not found');
      }
      if (booking.status === 'completed') return;
      if (booking.status !== 'started') {
        throw apiError(
          'Only a started booking can be completed',
          HttpStatus.CONFLICT,
        );
      }
      const now = new Date();
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: 'completed', completedAt: now },
      });
      await tx.bookingStatusEvent.create({
        data: {
          bookingId,
          status: 'completed',
          actorType: 'pro',
          actorId: proId,
          occurredAt: now,
        },
      });
      await tx.pro.update({
        where: { id: proId },
        data: { completedJobs: { increment: 1 } },
      });
    });
  }

  async recordReview(input: {
    bookingId: string;
    customerId: string;
    proId: string;
    rating: number;
    comment?: string;
    tags?: string[];
  }): Promise<void> {
    if (
      !Number.isInteger(input.rating) ||
      input.rating < 1 ||
      input.rating > 5
    ) {
      throw apiError('rating must be an integer from 1 to 5');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`review:${input.bookingId}`}, 0))`;
      const existing = await tx.review.findUnique({
        where: { bookingId: input.bookingId },
      });
      if (existing) return;
      const booking = await tx.booking.findUnique({
        where: { id: input.bookingId },
      });
      if (
        !booking ||
        booking.status !== 'completed' ||
        booking.customerId !== input.customerId ||
        booking.proId !== input.proId
      ) {
        throw apiError(
          'Only the customer on a completed booking may review its assigned Pro',
          HttpStatus.CONFLICT,
        );
      }
      await tx.review.create({
        data: {
          bookingId: input.bookingId,
          customerId: input.customerId,
          proId: input.proId,
          rating: input.rating,
          comment: input.comment,
          tags: input.tags ?? [],
        },
      });
      await tx.pro.update({
        where: { id: input.proId },
        data: {
          ratingSum: { increment: input.rating },
          ratingCount: { increment: 1 },
        },
      });
    });
  }

  async rebuildAll(): Promise<boolean> {
    const locked = await this.redis.setIfAbsent(REBUILD_LOCK, '1', 3600);
    if (!locked) return false;
    try {
      const [drift] = await this.prisma.$queryRaw<
        {
          ratingDrift: bigint;
          assignmentDrift: bigint;
          completionDrift: bigint;
        }[]
      >`
        WITH ratings AS (
          SELECT "proId", COALESCE(SUM("rating"), 0)::int AS sum, COUNT(*)::int AS count
          FROM "reviews" GROUP BY "proId"
        ), offers AS (
          SELECT "proId", COUNT(*)::int AS count FROM "assignment_candidates"
          WHERE "isWinner" = true GROUP BY "proId"
        ), acknowledgements AS (
          SELECT "actorId", COUNT(*)::int AS count FROM "booking_status_events"
          WHERE "actorType" = 'pro' AND "status" = ${ACK_EVENT} GROUP BY "actorId"
        ), completions AS (
          SELECT "proId", COUNT(*)::int AS count FROM "bookings"
          WHERE "status" = 'completed' AND "proId" IS NOT NULL GROUP BY "proId"
        )
        SELECT
          COUNT(*) FILTER (WHERE p."ratingSum" <> COALESCE(r.sum, 0) OR p."ratingCount" <> COALESCE(r.count, 0)) AS "ratingDrift",
          COUNT(*) FILTER (WHERE p."assignmentsOffered" <> COALESCE(o.count, 0) OR p."assignmentsAcknowledged" <> COALESCE(a.count, 0)) AS "assignmentDrift",
          COUNT(*) FILTER (WHERE p."completedJobs" <> COALESCE(c.count, 0)) AS "completionDrift"
        FROM "pros" p
        LEFT JOIN ratings r ON r."proId" = p.id
        LEFT JOIN offers o ON o."proId" = p.id
        LEFT JOIN acknowledgements a ON a."actorId" = p.id::text
        LEFT JOIN completions c ON c."proId" = p.id
      `;
      if (drift?.ratingDrift > 0n) {
        this.logger.error(
          `Rating counter drift detected for ${drift.ratingDrift} Pros`,
        );
      }
      if (drift?.assignmentDrift > 0n) {
        this.logger.warn(
          `Assignment counter drift detected for ${drift.assignmentDrift} Pros`,
        );
      }
      if (drift?.completionDrift > 0n) {
        this.logger.warn(
          `Completed-job counter drift detected for ${drift.completionDrift} Pros`,
        );
      }

      await this.prisma.$executeRaw`
        WITH ratings AS (
          SELECT "proId", COALESCE(SUM("rating"), 0)::int AS sum, COUNT(*)::int AS count
          FROM "reviews" GROUP BY "proId"
        ), offers AS (
          SELECT "proId", COUNT(*)::int AS count FROM "assignment_candidates"
          WHERE "isWinner" = true GROUP BY "proId"
        ), acknowledgements AS (
          SELECT "actorId", COUNT(*)::int AS count FROM "booking_status_events"
          WHERE "actorType" = 'pro' AND "status" = ${ACK_EVENT} GROUP BY "actorId"
        ), completions AS (
          SELECT "proId", COUNT(*)::int AS count FROM "bookings"
          WHERE "status" = 'completed' AND "proId" IS NOT NULL GROUP BY "proId"
        ), rebuilt AS (
          SELECT p.id,
            COALESCE(r.sum, 0) AS rating_sum,
            COALESCE(r.count, 0) AS rating_count,
            COALESCE(o.count, 0) AS offered,
            COALESCE(a.count, 0) AS acknowledged,
            COALESCE(c.count, 0) AS completed
          FROM "pros" p
          LEFT JOIN ratings r ON r."proId" = p.id
          LEFT JOIN offers o ON o."proId" = p.id
          LEFT JOIN acknowledgements a ON a."actorId" = p.id::text
          LEFT JOIN completions c ON c."proId" = p.id
        )
        UPDATE "pros" p SET
          "ratingSum" = rebuilt.rating_sum,
          "ratingCount" = rebuilt.rating_count,
          "assignmentsOffered" = rebuilt.offered,
          "assignmentsAcknowledged" = rebuilt.acknowledged,
          "acceptanceRate" = CASE WHEN rebuilt.offered = 0 THEN NULL ELSE rebuilt.acknowledged::float / rebuilt.offered END,
          "completedJobs" = rebuilt.completed,
          "countersRebuiltAt" = CURRENT_TIMESTAMP
        FROM rebuilt WHERE p.id = rebuilt.id
      `;
      return true;
    } finally {
      await this.redis.del(REBUILD_LOCK);
    }
  }

  private scheduleNextRebuild(): void {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(20, 30, 0, 0); // 02:00 Asia/Kolkata
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    this.timer = setTimeout(() => {
      void this.rebuildAll()
        .catch((error: unknown) =>
          this.logger.error(
            `Pro counter rebuild failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          ),
        )
        .finally(() => this.scheduleNextRebuild());
    }, next.getTime() - now.getTime());
    this.timer.unref();
  }
}
