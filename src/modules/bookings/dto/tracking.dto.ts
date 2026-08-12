import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class TrackingPositionDto {
  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;
}

/** Swagger mirror of the live-tracking view. Nothing here is stored. */
export class TrackingDto {
  @ApiProperty()
  status: string;

  @ApiPropertyOptional({ nullable: true })
  proId: string | null;

  @ApiPropertyOptional({
    type: TrackingPositionDto,
    nullable: true,
    description: 'Null when the Pro has never reported a position.',
  })
  position: { lat: number; lng: number } | null;

  @ApiProperty({
    description:
      'True when the position is a last-known fallback rather than live. The ' +
      'client must say so — a frozen pin presented as current reads as ' +
      '"they’ve parked" when it means "we lost them".',
  })
  isStale: boolean;

  @ApiPropertyOptional({ nullable: true })
  lastReportedAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 12,
    description:
      'Road minutes to the door, traffic-aware.\n\n' +
      '**Null is a real answer and must be rendered as one** — show "on the ' +
      'way", never "0 min". It means no live position, a stale one, no route ' +
      'found, or no routing key on this deployment. A straight-line guess is ' +
      'never published here: the platform would rather say nothing than have ' +
      'a customer stood at the door on a number that was never a road time.',
  })
  etaMinutes: number | null;
}
