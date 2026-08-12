import { Logger } from '@nestjs/common';
import {
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { TokenService } from '../identity/services/token.service';
import { BookingTrackingService } from './booking-tracking.service';

/** What a client is told about where their Pro is. */
export interface TrackingFrame {
  bookingId: string;
  status: string;
  proId: string | null;
  position: { lat: number; lng: number } | null;
  /** True when the Pro's phone has stopped reporting. */
  isStale: boolean;
  lastReportedAt: Date | null;
  /** Road minutes, or null. Null means "no number worth showing". */
  etaMinutes: number | null;
}

type AuthedSocket = Socket & { user?: AuthenticatedUser };

/** One room per booking. Membership is proven, never claimed. */
export const bookingRoom = (bookingId: string): string =>
  `booking:${bookingId}`;

/**
 * Live tracking, pushed rather than polled.
 *
 * `GET /bookings/:id/tracking` still exists and still works — it is the
 * fallback for a client that cannot hold a socket open, and the two return the
 * same shape from the same service. This gateway does not replace it; it
 * removes the two-to-five second lag between a Pro moving and the customer's
 * map catching up.
 *
 * ## Authentication, and why it is middleware
 *
 * The `JwtAuthGuard` is HTTP-only — it reads `request.headers.authorization`,
 * which a WebSocket handshake does not have in the same shape. So the token
 * arrives in the Socket.IO handshake `auth` payload and is verified through
 * the same `TokenService` the HTTP guard uses.
 *
 * It runs as **handshake middleware**, not in `handleConnection`, and that is
 * not a stylistic choice. `handleConnection` is async, while `connect` fires
 * on the client as soon as the transport is up — so a client that emits
 * `track` immediately (which every sensible client does) races the token
 * verification and arrives before `client.user` exists. Live testing caught
 * exactly that: a valid customer got "Not authenticated" on their first
 * message. Middleware completes *during* the handshake, so by the time any
 * message can be received the identity is already attached or the socket was
 * never accepted.
 *
 * Verifying once per connection rather than per message is deliberate: a
 * socket lives for minutes, and re-verifying every frame would hammer Redis
 * for an identity that cannot change mid-connection without the session being
 * revoked — and a revoked session fails the ownership check on its next
 * subscribe anyway.
 *
 * ## Why rooms, and why membership is checked
 *
 * A client asks to follow a booking; the server checks that booking is
 * **theirs** before joining them to its room. Without that check any
 * authenticated customer could subscribe to any booking id and watch a
 * stranger's Pro drive around. The ownership check is the same one the HTTP
 * tracking route makes, reused rather than reimplemented.
 */
@WebSocketGateway({
  namespace: '/tracking',
  // The customer app and the admin console are separate origins; the same
  // CORS_ORIGIN that governs HTTP governs this.
  cors: { origin: process.env.CORS_ORIGIN ?? '*' },
})
export class TrackingGateway implements OnGatewayInit, OnGatewayDisconnect {
  private readonly logger = new Logger(TrackingGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly tracking: BookingTrackingService,
  ) {}

  afterInit(server: Server): void {
    server.use((socket: AuthedSocket, next: (err?: Error) => void) => {
      void this.authenticate(socket)
        .then(() => next())
        // A rejected handshake surfaces on the client as `connect_error` with
        // this message, so it can tell "your token expired, log in again" from
        // "the network is down, keep retrying".
        .catch(() => next(new Error('Not authenticated')));
    });
  }

  private async authenticate(client: AuthedSocket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      stripBearer(client.handshake.headers.authorization);

    if (!token) throw new Error('Missing access token');

    // Deliberately not distinguishing expired from revoked from malformed. A
    // socket is a public surface, and the difference tells a prober more than
    // it tells a legitimate client — which reconnects with a fresh token
    // either way.
    const tokenUser = await this.tokens.verifyAccessToken(token);
    client.user = await this.tokens.resolveCurrentIdentity(tokenUser);
  }

  handleDisconnect(client: AuthedSocket): void {
    // Socket.IO removes the socket from its rooms itself; nothing to unwind.
    this.logger.debug(
      `Tracking socket closed for ${client.user?.id ?? 'anon'}`,
    );
  }

  /**
   * Follow one booking. The server proves ownership before joining the room,
   * and answers immediately with the current position so a client that
   * connects mid-journey does not stare at an empty map until the Pro's next
   * ping.
   */
  @SubscribeMessage('track')
  async track(
    client: AuthedSocket,
    payload: { bookingId?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!client.user) return { ok: false, error: 'Not authenticated' };

    const bookingId = payload?.bookingId;
    if (!bookingId) return { ok: false, error: 'bookingId is required' };

    try {
      // The ownership check IS this call — it throws a 404 for a booking that
      // is not the caller's, exactly as the HTTP route does. A socket must not
      // get a weaker check than a request.
      const frame = await this.tracking.getTracking(client.user.id, bookingId);

      await client.join(bookingRoom(bookingId));
      client.emit('tracking', { bookingId, ...frame });
      return { ok: true };
    } catch {
      // Same non-disclosure as the HTTP route: someone else's booking reads
      // exactly like one that never existed.
      return { ok: false, error: 'Booking not found' };
    }
  }

  @SubscribeMessage('untrack')
  async untrack(
    client: AuthedSocket,
    payload: { bookingId?: string },
  ): Promise<{ ok: boolean }> {
    if (payload?.bookingId) await client.leave(bookingRoom(payload.bookingId));
    return { ok: true };
  }

  /**
   * Push a frame to everyone watching this booking.
   *
   * Called by the fan-out subscriber rather than directly by the Pro's ping,
   * because the instance holding the customer's socket is usually **not** the
   * one that received the Pro's location.
   */
  publish(frame: TrackingFrame): void {
    this.server?.to(bookingRoom(frame.bookingId)).emit('tracking', frame);
  }
}

function stripBearer(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}
