/**
 * Pub/sub channels, and the shapes carried on them.
 *
 * Here rather than in either module because a channel is a **contract between
 * two modules that must not depend on each other**. Module 6 publishes a Pro's
 * movement; module 4 subscribes and pushes it to the customers watching. Yet
 * `BookingsModule` already imports `ProsModule`, so the reverse import would
 * be a cycle — and the whole point of a message bus is that neither side holds
 * a reference to the other.
 *
 * Redis is the decoupling. This file is just the agreement about what travels
 * over it.
 */

/** A Pro reported a new position. Published by module 6, consumed by module 4. */
export const TRACKING_CHANNEL = 'tracking:positions';

export interface ProMovedMessage {
  proId: string;
  lat: number;
  lng: number;
  /** ISO 8601. Serialised because it crosses a process boundary as JSON. */
  reportedAt: string;
}
