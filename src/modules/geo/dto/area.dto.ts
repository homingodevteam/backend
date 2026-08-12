import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * An area is an axis-aligned rectangle with **half-open** bounds:
 * `minLat <= lat < maxLat AND minLng <= lng < maxLng`.
 *
 * That asymmetry is what lets a grid tile exactly — a pin on the edge two
 * cells share belongs to precisely one of them.
 */
export class AreaBoundsDto {
  @ApiProperty({ example: 'Vijay Nagar' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 22.7283, description: 'Southern edge — inclusive.' })
  @Type(() => Number)
  @IsLatitude()
  minLat: number;

  @ApiProperty({ example: 22.7823, description: 'Northern edge — exclusive.' })
  @Type(() => Number)
  @IsLatitude()
  maxLat: number;

  @ApiProperty({ example: 75.8645, description: 'Western edge — inclusive.' })
  @Type(() => Number)
  @IsLongitude()
  minLng: number;

  @ApiProperty({ example: 75.9229, description: 'Eastern edge — exclusive.' })
  @Type(() => Number)
  @IsLongitude()
  maxLng: number;
}

export class CreateAreaDto extends AreaBoundsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  cityId: string;
}

export class GenerateGridDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  cityId: string;

  @ApiProperty({ example: 22.7196, description: 'Roughly the city centre.' })
  @Type(() => Number)
  @IsLatitude()
  centerLat: number;

  @ApiProperty({ example: 75.857 })
  @Type(() => Number)
  @IsLongitude()
  centerLng: number;

  @ApiProperty({
    example: 15,
    minimum: 1,
    maximum: 100,
    description:
      'Half-width: how far out from the centre to cover. 15 produces a 30 km ' +
      'square, which comfortably contains Indore.',
  })
  @Type(() => Number)
  @Min(1)
  @Max(100)
  extentKm: number;

  @ApiProperty({
    example: 6,
    minimum: 0.5,
    maximum: 50,
    description:
      'Side length of one cell. At 6 km an Indore-sized city wants a 5×5 to ' +
      '6×6 grid — around 25–36 cells, most of which you will deactivate.',
  })
  @Type(() => Number)
  @Min(0.5)
  @Max(50)
  cellSizeKm: number;
}

export class UpdateAreaDto {
  @ApiPropertyOptional({
    description: 'Rename a generated cell to what it actually is.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  minLat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  maxLat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  minLng?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  maxLng?: number;

  @ApiPropertyOptional({
    description:
      'Deactivating stops the cell resolving for NEW pins — this is how you ' +
      'drop generated cells that fall outside the city. Bookings already ' +
      'taken keep it.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class BulkCreateAreasDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  cityId: string;

  @ApiProperty({
    type: [AreaBoundsDto],
    description:
      'All-or-nothing. A partly-created city map is worse than none, because ' +
      'the gaps are invisible until a customer falls in one. For opening a ' +
      'city, prefer `POST /admin/areas/generate-grid` — it tiles by ' +
      'construction, where hand-drawn rectangles can leave holes.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(400)
  @ValidateNested({ each: true })
  @Type(() => AreaBoundsDto)
  areas: AreaBoundsDto[];
}

export class SetAreaServicesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'The COMPLETE list for this area. Anything omitted is switched off. ' +
      'Send `[]` to make the area offer nothing. Idempotent.',
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  serviceIds: string[];
}

export class CopyAreaServicesDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The area to copy availability FROM. Its list replaces this one.',
  })
  @IsUUID()
  sourceAreaId: string;
}

export class SetServiceAcrossAreasDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  areaIds: string[];

  @ApiProperty()
  @IsBoolean()
  isActive: boolean;
}

export class SetAreaServiceDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceId: string;

  @ApiProperty({ description: 'False removes the service from this area.' })
  @IsBoolean()
  isActive: boolean;
}

export class SetProAreaDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  proId: string;

  @ApiProperty()
  @IsBoolean()
  isActive: boolean;
}

/** Query for the customer-facing serviceability check. */
export class ResolveLocationQueryDto {
  @ApiProperty({ example: 22.7533 })
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 75.8937 })
  @Type(() => Number)
  @IsLongitude()
  lng: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Omit to ask only "do you operate here?". Include it to also ask "is ' +
      'this service available here?" — two different answers with two ' +
      'different messages.',
  })
  @IsOptional()
  @IsUUID()
  serviceId?: string;
}

export class AreaDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  cityId: string;

  @ApiProperty({
    example: 'Vijay Nagar',
    description:
      'Generated cells are named by grid position (`A1`, `B3`) until an admin ' +
      'renames them.',
  })
  name: string;

  @ApiProperty({ example: 22.7283, description: 'Southern edge — inclusive.' })
  minLat: number;

  @ApiProperty({ example: 22.7823, description: 'Northern edge — exclusive.' })
  maxLat: number;

  @ApiProperty({ example: 75.8645, description: 'Western edge — inclusive.' })
  minLng: number;

  @ApiProperty({ example: 75.9229, description: 'Eastern edge — exclusive.' })
  maxLng: number;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class ResolvedAreaDto {
  @ApiProperty()
  areaId: string;

  @ApiProperty()
  areaName: string;

  @ApiProperty()
  cityId: string;

  @ApiProperty()
  cityName: string;
}

export class ServiceabilityDto {
  @ApiProperty()
  serviceable: boolean;

  @ApiPropertyOptional({
    type: ResolvedAreaDto,
    nullable: true,
    description:
      'Null when the pin fell outside every active area. Present but with ' +
      '`serviceable: false` when we operate there but not for that service.',
  })
  area: ResolvedAreaDto | null;

  @ApiPropertyOptional({ description: 'Safe to show the customer verbatim.' })
  reason?: string;

  @ApiPropertyOptional({
    enum: ['LOCATION_NOT_SERVICEABLE', 'SERVICE_NOT_AVAILABLE_IN_AREA'],
  })
  code?: string;
}

/** Query for the location-filtered catalogue. */
export class LocationCatalogQueryDto {
  @ApiProperty({ example: 22.7533 })
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 75.8937 })
  @Type(() => Number)
  @IsLongitude()
  lng: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restrict to one category.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    minLength: 2,
    description: 'Case-insensitive substring match on name and description.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  q?: string;

  @ApiPropertyOptional({ enum: ['instant', 'scheduled', 'recurring'] })
  @IsOptional()
  @IsIn(['instant', 'scheduled', 'recurring'])
  bookingType?: 'instant' | 'scheduled' | 'recurring';
}

export class LocationServiceDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Split AC Service' })
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty({ type: String, example: '599.00' })
  flatPrice: string;

  @ApiProperty()
  durationMinutes: number;

  @ApiProperty({ description: 'Whether cash is offered for this service.' })
  allowsCash: boolean;

  @ApiProperty({
    description: 'Whether this service can be booked at the pin that was sent.',
  })
  isAvailable: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Safe to show the customer verbatim. Null when available.',
  })
  unavailableReason: string | null;
}

/**
 * The app's first screen: the catalogue, answered for one pin.
 *
 * Unavailable services are **returned and flagged, not hidden** — a
 * thinly-mapped area would otherwise look like an empty product, and what
 * customers tried to book where they could not is the signal that tells ops
 * where to expand.
 */
export class LocationCatalogDto {
  @ApiPropertyOptional({
    type: ResolvedAreaDto,
    nullable: true,
    description: 'Null when the pin falls outside every active area.',
  })
  area: ResolvedAreaDto | null;

  @ApiProperty()
  serviceable: boolean;

  @ApiPropertyOptional({
    description: 'Present only when `serviceable` is false.',
  })
  reason?: string;

  @ApiPropertyOptional({ enum: ['LOCATION_NOT_SERVICEABLE'] })
  code?: string;

  @ApiProperty({ type: [LocationServiceDto] })
  services: LocationServiceDto[];
}

/** A Pro posted to an area, named rather than referenced by id. */
export class ProPostingDto {
  @ApiProperty()
  id: string;

  @ApiPropertyOptional({ nullable: true })
  fullName: string | null;

  @ApiProperty()
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  employeeCode: string | null;

  @ApiProperty({
    enum: ['applied', 'under_review', 'approved', 'suspended', 'rejected'],
  })
  status: string;

  @ApiProperty({
    description: 'On/off duty — separate from being posted here.',
  })
  isAvailable: boolean;
}

/** An area a Pro is posted to, carrying its city so the name reads alone. */
export class AreaPostingDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Vijay Nagar' })
  name: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  cityId: string;

  @ApiProperty({ example: 'Indore' })
  cityName: string;

  @ApiProperty({ example: 'Madhya Pradesh' })
  cityState: string;
}

export class AreaOverlapDto {
  @ApiProperty()
  areaId: string;

  @ApiProperty()
  areaName: string;

  @ApiProperty({
    example: 4.25,
    description:
      'Square kilometres the two rectangles share. A generated grid produces ' +
      'none — anything here means a hand-edit broke the tiling.',
  })
  overlapSqKm: number;
}
