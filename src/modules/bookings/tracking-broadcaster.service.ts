import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TRACKING_CHANNEL, type ProMovedMessage } from '../../redis/channels';
import { RedisService } from '../../redis/redis.service';
import { TRACKABLE_STATUSES } from './booking-tracking.service';
import { TrackingGateway, type TrackingFrame } from './tracking.gateway';

/**
 * Carries a Pro's movement to the customers watching them.
 *
 * ## Why this is not just `gateway.publish()` at the ingest site
 *
 * A Pro's location arrives by `POST /pros/me/location`, which lands on
 * whichever instance the load balancer picked. The customer watching that Pro
 * holds a socket on whichever instance *their* app connected to. On any
 * deployment with more than one box those are usually different processes, and
 * emitting straight to the local Socket.IO server would reach only the
 * customers who happened to land on the same one — a bug that is invisible on
 * a developer's laptop and shows up as "tracking works for some people" in
 * production.
 *
 * So the ingest side publishes to Redis, and **every** instance subscribes and
 * emits to its own local rooms. A room with no local members is a no-op, so
 * the cost of the instances that do not care is a JSON parse.
 *
 * ## Why a Pro's position is turned into per-booking frames here
 *
 * Redis GEO knows where a Pro is; it does not know who is allowed to see them.
 * The subscriber resolves the Pro's currently trackable bookings and emits one
 * frame per booking room, so a customer only ever receives positions for a job
 * that is actually theirs and actually in flight.
 */
@Injectable()
export class TrackingBroadcasterService implements OnModuleInit {
  private readonly logger = new Logger(TrackingBroadcasterService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly gateway: TrackingGateway,
  ) {}

  onModuleInit(): void {
    this.redis.subscribe(TRACKING_CHANNEL, (payload) => {
      void this.fanOut(payload as ProMovedMessage);
    });
  }

  private async fanOut(moved: ProMovedMessage): Promise<void> {
    if (!moved?.proId) return;

    try {
      // Only jobs where somebody is genuinely waiting for an arrival. A
      // position during `started` would show a pin sitting on the customer's
      // own house for an hour, and after completion it would leak where the
      // Pro went next.
      const bookings = await this.prisma.booking.findMany({
        where: { proId: moved.proId, status: { in: [...TRACKABLE_STATUSES] } },
        select: { id: true, status: true },
      });

      for (const booking of bookings) {
        const frame: TrackingFrame = {
          bookingId: booking.id,
          status: booking.status,
          proId: moved.proId,
          position: { lat: moved.lat, lng: moved.lng },
          // Fresh by definition — this frame exists because a ping just
          // arrived. Staleness is the polled route's problem, where the
          // question "how old is this?" is the whole point.
          isStale: false,
          lastReportedAt: new Date(moved.reportedAt),
          // Still null, still deliberate. Nothing can compute a road ETA yet,
          // and a haversine guess published as an arrival time is worse than
          // no number at all.
          etaMinutes: null,
        };
        this.gateway.publish(frame);
      }
    } catch (error) {
      // A dropped frame costs one map update; the next ping is a second away.
      // Never worth taking the subscriber down for.
      this.logger.warn(
        `Could not fan out a position for Pro ${moved.proId}: ` +
          (error instanceof Error ? error.message : 'unknown error'),
      );
    }
  }
}
