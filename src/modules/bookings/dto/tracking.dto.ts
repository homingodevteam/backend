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
    description: 'Always null until Geo & Routing (module 13) computes it.',
  })
  etaMinutes: number | null;
}
