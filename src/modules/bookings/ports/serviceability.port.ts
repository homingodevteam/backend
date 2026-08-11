import { Injectable, Logger } from '@nestjs/common';

export const SERVICEABILITY_PORT = Symbol('SERVICEABILITY_PORT');

export interface ServiceabilityQuery {
  lat: number;
  lng: number;
  serviceId: string;
  cityId: string;
}

/**
 * What Booking needs from Geo & Routing (module 13), expressed as an interface
 * Booking owns.
 *
 * One method, and it returns rather than merely asserting: booking has to
 * **record** the resolved area on the row as well as be allowed to proceed.
 * Splitting that into "check" plus "resolve" would mean resolving the same pin
 * twice, and would let the two answers drift if areas were redrawn between
 * them.
 */
export interface ServiceabilityPort {
  /**
   * Throws when the location or service is not serviceable **and** the
   * per-city gate is enabled. Otherwise returns the area to freeze onto the
   * booking, which may be `null` when the pin resolved to nothing.
   */
  resolveForBooking(
    query: ServiceabilityQuery,
  ): Promise<{ areaId: string | null }>;
}

/**
 * Stand-in until module 13 registers.
 *
 * Permissive, and returns `null` — no areas exist to resolve against, so the
 * honest answer is "no area", not a refusal. This matters more than it looks:
 * a stub that threw would take the entire product offline the moment it was
 * bound, since every booking would fail the check.
 *
 * That is the same reason the real implementation ships with its enforcement
 * flag off. The gate is dangerous by nature — it can only reject — so both the
 * stub and the real thing default to letting work through, and enforcement is
 * turned on per city once that city has actually been mapped.
 */
@Injectable()
export class NoOpServiceabilityService implements ServiceabilityPort {
  private readonly logger = new Logger(NoOpServiceabilityService.name);

  private real: ServiceabilityPort | null = null;

  register(implementation: ServiceabilityPort): void {
    this.real = implementation;
    this.logger.log(
      'Service areas registered — bookings now resolve and record an area.',
    );
  }

  get isRegistered(): boolean {
    return this.real !== null;
  }

  resolveForBooking(
    query: ServiceabilityQuery,
  ): Promise<{ areaId: string | null }> {
    if (this.real) return this.real.resolveForBooking(query);
    return Promise.resolve({ areaId: null });
  }
}
