import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Area, AreaService as AreaServiceRow } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AreaPostingDto, ProPostingDto } from './dto/area.dto';
import {
  boxAreaSqKm,
  boxCenter,
  boxDimensionsKm,
  boxesOverlap,
  expandBox,
  generateGrid,
  type BoundingBox,
} from './geo.types';

export interface AreaOverlap {
  areaId: string;
  areaName: string;
  /** Square kilometres the two rectangles share. */
  overlapSqKm: number;
}

/** What an admin supplies to draw one rectangle. */
export interface AreaBounds extends BoundingBox {
  name: string;
}

@Injectable()
export class AreasService {
  private readonly logger = new Logger(AreasService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // Areas
  // ------------------------------------------------------------------

  /** One hand-drawn rectangle. The grid generator is the usual path. */
  async create(input: { cityId: string } & AreaBounds): Promise<Area> {
    await this.assertCityExists(input.cityId);
    assertValidBounds(input);

    const duplicate = await this.prisma.area.findFirst({
      where: { cityId: input.cityId, name: input.name },
      select: { id: true },
    });
    if (duplicate) {
      throw apiError(
        `This city already has an area called ${input.name}`,
        HttpStatus.CONFLICT,
        [{ field: 'name', message: 'Already exists', code: 'AREA_NAME_TAKEN' }],
      );
    }

    return this.prisma.area.create({
      data: {
        cityId: input.cityId,
        name: input.name,
        minLat: input.minLat,
        maxLat: input.maxLat,
        minLng: input.minLng,
        maxLng: input.maxLng,
      },
    });
  }

  /**
   * Draw a whole city's worth of rectangles in one call.
   *
   * The hand-drawn path, for refining a map after the generator has laid the
   * grid. All-or-nothing — a partly-created map is worse than none, because
   * the gaps are invisible until a customer falls in one.
   */
  async createMany(cityId: string, areas: AreaBounds[]): Promise<Area[]> {
    await this.assertCityExists(cityId);
    areas.forEach(assertValidBounds);

    const names = areas.map((area) => area.name);
    const duplicatesInPayload = names.filter(
      (name, index) => names.indexOf(name) !== index,
    );
    if (duplicatesInPayload.length > 0) {
      throw apiError(
        `Duplicate area names in this request: ${[...new Set(duplicatesInPayload)].join(', ')}`,
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'areas',
            message: 'Names must be unique',
            code: 'AREA_NAME_TAKEN',
          },
        ],
      );
    }

    const existing = await this.prisma.area.findMany({
      where: { cityId, name: { in: names } },
      select: { name: true },
    });
    if (existing.length > 0) {
      throw apiError(
        `This city already has: ${existing.map((area) => area.name).join(', ')}`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'areas',
            message: 'Already exists',
            code: 'AREA_NAME_TAKEN',
          },
        ],
      );
    }

    return this.prisma.$transaction(
      areas.map((area) =>
        this.prisma.area.create({
          data: {
            cityId,
            name: area.name,
            minLat: area.minLat,
            maxLat: area.maxLat,
            minLng: area.minLng,
            maxLng: area.maxLng,
          },
        }),
      ),
    );
  }

  /**
   * Lay a gapless grid of cells over a city. **The normal way to open one.**
   *
   * This is what rectangles buy. Cells come from one arithmetic progression
   * per axis, so adjacent cells share exact float boundaries and the grid
   * tiles with **no gaps and no overlap by construction** — there is nothing
   * to sample for holes afterwards, because holes cannot exist.
   *
   * Cells are named by grid position (`A1`, `B3`); the generator has no idea
   * what is on the ground. The workflow after this call is: rename the cells
   * that matter to real neighbourhoods, deactivate the ones that fall in
   * farmland or another district, and only then turn the booking gate on.
   *
   * Refuses to run on a city that already has areas. Generating a second grid
   * over an existing one is never what someone means, and the overlap it would
   * create is exactly the ambiguity this shape exists to avoid.
   */
  async generateGridForCity(input: {
    cityId: string;
    centerLat: number;
    centerLng: number;
    extentKm: number;
    cellSizeKm: number;
  }): Promise<Area[]> {
    await this.assertCityExists(input.cityId);

    const existing = await this.prisma.area.count({
      where: { cityId: input.cityId },
    });
    if (existing > 0) {
      throw apiError(
        `This city already has ${existing} areas. Generating a grid over them would overlap.`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'cityId',
            message: 'Deactivate or remove the existing areas first',
            code: 'CITY_ALREADY_MAPPED',
          },
        ],
      );
    }

    const cells = generateGrid(input);

    this.logger.log(
      `Generating ${cells.length} cells of ${input.cellSizeKm} km over city ${input.cityId}. ` +
        'Rename the ones that matter and deactivate the rest before enabling the booking gate.',
    );

    return this.prisma.$transaction(
      cells.map((cell) =>
        this.prisma.area.create({
          data: {
            cityId: input.cityId,
            // The positional label is both the initial name and a permanent
            // reference: ops keeps saying "cell C3" after it becomes "Vijay
            // Nagar", and `gridRef` is what survives the rename.
            name: cell.name,
            gridRef: cell.name,
            nameSource: 'generated',
            minLat: cell.minLat,
            maxLat: cell.maxLat,
            minLng: cell.minLng,
            maxLng: cell.maxLng,
          },
        }),
      ),
    );
  }

  async update(
    id: string,
    input: {
      name?: string;
      minLat?: number;
      maxLat?: number;
      minLng?: number;
      maxLng?: number;
      isActive?: boolean;
    },
  ): Promise<Area> {
    const area = await this.findByIdOrFail(id);

    const movesBounds =
      input.minLat !== undefined ||
      input.maxLat !== undefined ||
      input.minLng !== undefined ||
      input.maxLng !== undefined;

    if (movesBounds) {
      // Validate the merged result, not just what was sent — a request that
      // only moves `maxLat` can still invert the box.
      assertValidBounds({
        name: input.name ?? area.name,
        minLat: input.minLat ?? area.minLat,
        maxLat: input.maxLat ?? area.maxLat,
        minLng: input.minLng ?? area.minLng,
        maxLng: input.maxLng ?? area.maxLng,
      });

      // Moving a cell breaks the grid's tiling: its old neighbours no longer
      // share an edge with it, which opens a gap or an overlap that nothing
      // else will notice. Existing bookings keep their frozen `areaId`, which
      // is the whole reason that column exists.
      this.logger.warn(
        `Area ${area.name} (${id}) is being re-bounded. If it came from a generated ` +
          'grid its neighbours no longer tile with it — check /overlaps afterwards. ' +
          'Bookings already taken keep the area they were sold into.',
      );
    }

    // A name a human typed is `manual` forever after. That is what makes the
    // naming pass safe to re-run: it only ever touches `generated` rows, so it
    // can never overwrite a decision somebody made.
    const renamed = input.name !== undefined && input.name !== area.name;

    return this.prisma.area.update({
      where: { id },
      data: { ...input, ...(renamed ? { nameSource: 'manual' } : {}) },
    });
  }

  listForCity(cityId: string, includeInactive = false): Promise<Area[]> {
    return this.prisma.area.findMany({
      where: { cityId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { name: 'asc' },
    });
  }

  async findByIdOrFail(id: string): Promise<Area> {
    const area = await this.prisma.area.findUnique({ where: { id } });
    if (!area) throw apiError('Area not found', HttpStatus.NOT_FOUND);
    return area;
  }

  /**
   * Which other areas in the city this one genuinely overlaps.
   *
   * **The meaning inverted when the shape changed.** With circles, overlap was
   * expected and healthy — it was what kept a city gapless. With rectangles it
   * is a *warning*: a generated grid tiles exactly, so a non-empty result here
   * means someone has hand-edited bounds and the map is no longer a clean
   * partition. The resolver still answers deterministically (smallest box
   * wins), but two areas claiming the same ground is now a thing to look at
   * rather than the design working as intended.
   *
   * Touching edges are not overlap. Adjacent cells share a boundary by design,
   * and half-open bounds mean a pin on it belongs to exactly one of them.
   */
  async overlapsFor(id: string): Promise<AreaOverlap[]> {
    const area = await this.findByIdOrFail(id);

    const siblings = await this.prisma.area.findMany({
      where: { cityId: area.cityId, isActive: true, id: { not: id } },
    });

    return siblings
      .filter((other) => boxesOverlap(area, other))
      .map((other) => ({
        areaId: other.id,
        areaName: other.name,
        overlapSqKm: Number(
          boxAreaSqKm({
            minLat: Math.max(area.minLat, other.minLat),
            maxLat: Math.min(area.maxLat, other.maxLat),
            minLng: Math.max(area.minLng, other.minLng),
            maxLng: Math.min(area.maxLng, other.maxLng),
          }).toFixed(3),
        ),
      }))
      .sort((a, b) => b.overlapSqKm - a.overlapSqKm);
  }

  /**
   * An area, plus everything derivable from its bounds that an admin needs to
   * recognise it: centre, size, and a link that opens the spot in Google Maps.
   *
   * The map link is the cheap half of "which square is this?". Four raw
   * coordinates tell a human nothing; one click tells them everything. The
   * expensive half — a suggested name — is `AreaNamingService`.
   *
   * All derived, none stored. A rectangle already implies its centre, and a
   * stored copy would be one more thing to keep in step when bounds move.
   */
  describe<T extends Area>(area: T) {
    // Six decimals is ~11 cm — far finer than a 6 km cell needs, and it keeps
    // float noise out of the payload. A midpoint of two stored floats lands on
    // 22.686999999999998 often enough that an unrounded map link looks broken.
    const centre = boxCenter(area);
    const lat = Number(centre.lat.toFixed(6));
    const lng = Number(centre.lng.toFixed(6));

    return {
      ...area,
      ...boxDimensionsKm(area),
      centerLat: lat,
      centerLng: lng,
      mapUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    };
  }

  /** The list an admin reviews, each row ready to be recognised. */
  async describeForCity(cityId: string, includeInactive = false) {
    const areas = await this.listForCity(cityId, includeInactive);
    return areas.map((area) => this.describe(area));
  }

  private async assertCityExists(cityId: string): Promise<void> {
    const city = await this.prisma.city.findUnique({
      where: { id: cityId },
      select: { id: true },
    });
    if (!city) {
      throw apiError('City not found', HttpStatus.NOT_FOUND, [
        { field: 'cityId', message: 'No such city', code: 'CITY_NOT_FOUND' },
      ]);
    }
  }

  // ------------------------------------------------------------------
  // Area ↔ Service
  // ------------------------------------------------------------------

  /**
   * Turn a service on or off in an area. Upsert rather than create, so an
   * admin re-enabling a service they previously switched off does not hit a
   * unique-constraint error for doing the obvious thing.
   */
  async setServiceAvailability(
    areaId: string,
    serviceId: string,
    isActive: boolean,
  ): Promise<AreaServiceRow> {
    await this.findByIdOrFail(areaId);

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true },
    });
    if (!service) {
      throw apiError('Service not found', HttpStatus.NOT_FOUND, [
        {
          field: 'serviceId',
          message: 'No such service',
          code: 'SERVICE_NOT_FOUND',
        },
      ]);
    }

    // Only activation is gated. Switching a service OFF must always be
    // possible — otherwise an area that lost its last Pro could never be
    // corrected, which is exactly when someone needs to switch it off.
    if (isActive) await this.assertStaffed(areaId, serviceId);

    return this.prisma.areaService.upsert({
      where: { areaId_serviceId: { areaId, serviceId } },
      update: { isActive },
      create: { areaId, serviceId, isActive },
    });
  }

  listServicesForArea(areaId: string) {
    return this.prisma.areaService.findMany({
      where: { areaId },
      include: {
        service: { select: { id: true, name: true, isActive: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Replace an area's entire service list in one call.
   *
   * **Declarative, not incremental**: whatever is in `serviceIds` ends up
   * active and everything else in that area ends up inactive. Sending the same
   * list twice changes nothing, and there is no way to end up with a half-
   * applied list because it is one transaction.
   *
   * That matters more than it sounds for an admin screen. The incremental
   * alternative — a toggle per service — means the screen has to diff its own
   * state against the server's and fire N calls, and if one fails the area is
   * left in a state neither the admin nor the server intended.
   *
   * Rows are **deactivated, never deleted**. `isActive: false` and "no row"
   * resolve identically, but the row records that someone considered this
   * service here and switched it off, which a deletion erases.
   */
  async setServicesForArea(
    areaId: string,
    serviceIds: string[],
  ): Promise<{ activated: number; deactivated: number }> {
    await this.findByIdOrFail(areaId);

    const unique = [...new Set(serviceIds)];

    if (unique.length > 0) {
      const found = await this.prisma.service.findMany({
        where: { id: { in: unique } },
        select: { id: true },
      });

      if (found.length !== unique.length) {
        const known = new Set(found.map((service) => service.id));
        const missing = unique.filter((id) => !known.has(id));
        // All-or-nothing. A partial apply would leave the admin's screen
        // disagreeing with the database about what they just saved.
        throw apiError(
          'Some of those services do not exist',
          HttpStatus.NOT_FOUND,
          missing.map((id) => ({
            field: 'serviceIds',
            message: `No service ${id}`,
            code: 'SERVICE_NOT_FOUND',
          })),
        );
      }
    }

    // Every service being switched ON has to be staffed. Checked before the
    // transaction opens so a rejection leaves nothing half-applied — the same
    // all-or-nothing promise the unknown-service check above makes.
    for (const serviceId of unique) {
      await this.assertStaffed(areaId, serviceId);
    }

    return this.prisma.$transaction(async (tx) => {
      const deactivated = await tx.areaService.updateMany({
        where: { areaId, serviceId: { notIn: unique }, isActive: true },
        data: { isActive: false },
      });

      for (const serviceId of unique) {
        await tx.areaService.upsert({
          where: { areaId_serviceId: { areaId, serviceId } },
          update: { isActive: true },
          create: { areaId, serviceId, isActive: true },
        });
      }

      return { activated: unique.length, deactivated: deactivated.count };
    });
  }

  /**
   * Clone one area's availability onto another.
   *
   * The single biggest time-saver in this whole surface. Neighbouring areas of
   * a city almost always offer the same catalogue, so the real workflow is
   * "set up Vijay Nagar properly, then make the other five match" — which is
   * one call per area instead of one call per area per service.
   */
  async copyServicesBetweenAreas(
    sourceAreaId: string,
    targetAreaId: string,
  ): Promise<{ activated: number; deactivated: number }> {
    if (sourceAreaId === targetAreaId) {
      throw apiError(
        'Pick a different area to copy from',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'sourceAreaId',
            message: 'Source and target are the same area',
            code: 'AREA_COPY_SELF',
          },
        ],
      );
    }

    await this.findByIdOrFail(sourceAreaId);

    const source = await this.prisma.areaService.findMany({
      where: { areaId: sourceAreaId, isActive: true },
      select: { serviceId: true },
    });

    return this.setServicesForArea(
      targetAreaId,
      source.map((row) => row.serviceId),
    );
  }

  /**
   * The other direction: one service across many areas at once.
   *
   * "We now do AC repair everywhere in Indore" is a single decision, and
   * making an admin open six area screens to express it is how areas end up
   * inconsistent.
   */
  async setServiceAcrossAreas(
    serviceId: string,
    areaIds: string[],
    isActive: boolean,
  ): Promise<{ updated: number }> {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true },
    });
    if (!service) {
      throw apiError('Service not found', HttpStatus.NOT_FOUND);
    }

    const unique = [...new Set(areaIds)];
    const found = await this.prisma.area.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });

    if (found.length !== unique.length) {
      throw apiError('Some of those areas do not exist', HttpStatus.NOT_FOUND, [
        {
          field: 'areaIds',
          message: 'Unknown area id',
          code: 'AREA_NOT_FOUND',
        },
      ]);
    }

    // "AC repair everywhere in Indore" is the call most likely to switch a
    // service on somewhere nobody is staffed — it names areas in bulk, so
    // nobody is looking at them one at a time.
    if (isActive) {
      for (const areaId of unique) {
        await this.assertStaffed(areaId, serviceId);
      }
    }

    await this.prisma.$transaction(
      unique.map((areaId) =>
        this.prisma.areaService.upsert({
          where: { areaId_serviceId: { areaId, serviceId } },
          update: { isActive },
          create: { areaId, serviceId, isActive },
        }),
      ),
    );

    return { updated: unique.length };
  }

  /**
   * Every area in a city against every live service, as a grid.
   *
   * The view that makes the map's state comprehensible. Toggling services one
   * at a time is fine; knowing *which* of six areas is missing the deep clean
   * is not something you can see from six separate lists.
   *
   * Includes services with **no row at all** as `false`, because "never
   * configured" and "switched off" look identical to a customer and an admin
   * needs to see both as gaps.
   */
  async serviceMatrixForCity(cityId: string) {
    const [areas, services] = await Promise.all([
      this.prisma.area.findMany({
        where: { cityId },
        orderBy: { name: 'asc' },
        include: {
          areaServices: { select: { serviceId: true, isActive: true } },
        },
      }),
      this.prisma.service.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
    ]);

    return {
      cityId,
      services,
      areas: areas.map((area) => {
        const byService = new Map(
          area.areaServices.map((row) => [row.serviceId, row.isActive]),
        );
        return {
          areaId: area.id,
          areaName: area.name,
          isActive: area.isActive,
          availability: services.map((service) => ({
            serviceId: service.id,
            serviceName: service.name,
            isAvailable: byService.get(service.id) === true,
            // The distinction an admin needs: nobody has decided yet, versus
            // somebody decided no.
            isConfigured: byService.has(service.id),
          })),
        };
      }),
    };
  }

  // ------------------------------------------------------------------
  // Pro ↔ Area
  // ------------------------------------------------------------------

  /**
   * Post a Pro to an area, or take them off it.
   *
   * Admin-set, like every other gate on a Pro — there is no self-service route
   * for this anywhere, for the same reason there is no accept/decline.
   */
  async setProArea(proId: string, areaId: string, isActive: boolean) {
    await this.findByIdOrFail(areaId);

    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      select: { id: true },
    });
    if (!pro) throw apiError('Pro not found', HttpStatus.NOT_FOUND);

    return this.prisma.proArea.upsert({
      where: { proId_areaId: { proId, areaId } },
      update: { isActive },
      create: { proId, areaId, isActive },
    });
  }

  listAreasForPro(proId: string) {
    return this.prisma.proArea.findMany({
      where: { proId },
      include: { area: { select: { id: true, name: true, cityId: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * The ids dispatch filters on.
   *
   * Returns `null` — not an empty array — when **no Pro is posted to this area
   * at all**. The two cases have to be distinguishable: an empty list would
   * make dispatch exclude everybody and report a supply gap in a city that has
   * simply not had its Pros posted yet, which is a configuration problem
   * wearing a supply problem's clothes.
   */
  async proIdsForArea(areaId: string): Promise<string[] | null> {
    return this.proIdsForAreas([areaId]);
  }

  /** The same question across several areas — dispatch's widening step. */
  async proIdsForAreas(areaIds: string[]): Promise<string[] | null> {
    if (areaIds.length === 0) return null;

    const rows = await this.prisma.proArea.findMany({
      where: { areaId: { in: areaIds }, isActive: true },
      select: { proId: true },
    });

    if (rows.length === 0) return null;
    return [...new Set(rows.map((row) => row.proId))];
  }

  /**
   * Areas adjacent to this one, found by expanding its box and asking what it
   * then overlaps.
   *
   * The rectangle model earns its keep here: with circles this needed a
   * centre-distance heuristic that got the corners wrong. Cells that share an
   * edge qualify at any margin above zero; cells across town never do.
   *
   * Same city only. Widening a Bhopal booking into Indore because the grids
   * happen to abut would be worse than not assigning it.
   */
  async neighbourIdsOf(areaId: string, marginKm: number): Promise<string[]> {
    const area = await this.findByIdOrFail(areaId);

    const siblings = await this.prisma.area.findMany({
      where: { cityId: area.cityId, isActive: true, id: { not: areaId } },
    });

    const grown = expandBox(area, marginKm);
    return siblings
      .filter((other) => boxesOverlap(grown, other))
      .map((other) => other.id);
  }

  /**
   * Is there anyone who could actually do this service here?
   *
   * The check that stops "we sell it here" and "someone can do it here" from
   * drifting apart. They are configured independently — `AreaService` by
   * whoever runs the catalogue, `ProArea` by whoever runs staffing — and
   * nothing else notices when they disagree.
   *
   * Counts **approved** Pros posted to the area who hold the service. It
   * deliberately ignores `isAvailable`: that flag is today's roster, and a
   * service should not become unsellable because everyone happens to be off
   * shift this afternoon. This answers the structural question — is anybody
   * staffed for this here at all — which is the one that maps to
   * CONFLICTS_AND_DECISIONS #31's `no_supply`.
   */
  async countProsCapableInArea(
    areaId: string,
    serviceId: string,
  ): Promise<number> {
    return this.prisma.pro.count({
      where: {
        status: 'approved',
        areas: { some: { areaId, isActive: true } },
        services: { some: { serviceId, isActive: true } },
      },
    });
  }

  /**
   * Refuses to switch a service on in an area nobody is staffed for.
   *
   * Extends US-3.9's city-launch supply gate down one level. That gate blocks
   * activating a city with no approved Pro; this blocks activating a service
   * in an area with nobody who can perform it — the same mistake at finer
   * grain, and now the more likely one, because areas are configured far more
   * often than cities are launched.
   *
   * Fails at the moment someone makes the mistake, to the person making it,
   * which is the only time it is cheap to fix. The alternative is discovering
   * it when a customer's booking cannot be assigned.
   */
  private async assertStaffed(
    areaId: string,
    serviceId: string,
  ): Promise<void> {
    const capable = await this.countProsCapableInArea(areaId, serviceId);
    if (capable > 0) return;

    const [area, service] = await Promise.all([
      this.prisma.area.findUnique({
        where: { id: areaId },
        select: { name: true },
      }),
      this.prisma.service.findUnique({
        where: { id: serviceId },
        select: { name: true },
      }),
    ]);

    throw apiError(
      `No approved Pro posted to ${area?.name ?? 'this area'} can perform ${service?.name ?? 'this service'}`,
      HttpStatus.CONFLICT,
      [
        {
          field: 'serviceId',
          message:
            'Post a Pro who holds this service to this area first, or the ' +
            'booking will be taken and then fail to assign',
          code: 'AREA_NOT_STAFFED_FOR_SERVICE',
        },
      ],
    );
  }

  /**
   * The same postings, shaped for a person rather than for dispatch.
   *
   * Deliberately separate from {@link proIdsForArea}: that one answers a
   * filtering question and encodes "nobody posted" as `null`, which is exactly
   * the wrong shape for a screen. This one always returns a list, and returns
   * names — a console showing bare uuids tells an admin nothing.
   */
  prosForArea(areaId: string): Promise<ProPostingDto[]> {
    return this.prisma.proArea
      .findMany({
        where: { areaId, isActive: true },
        select: {
          pro: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              employeeCode: true,
              status: true,
              isAvailable: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      })
      .then((rows) => rows.map((row) => row.pro));
  }

  /**
   * The inverse lookup: where is this one Pro posted?
   *
   * Answering it from the area side would mean one call per area, so it lives
   * here as a single query. Named `by-pro` on the controller to match the
   * `by-service` route that already inverts the other relation.
   */
  areasForPro(proId: string): Promise<AreaPostingDto[]> {
    return this.prisma.proArea
      .findMany({
        where: { proId, isActive: true },
        select: {
          area: {
            select: {
              id: true,
              name: true,
              isActive: true,
              cityId: true,
              city: { select: { name: true, state: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      })
      .then((rows) =>
        rows.map(({ area }) => ({
          id: area.id,
          name: area.name,
          isActive: area.isActive,
          cityId: area.cityId,
          cityName: area.city.name,
          cityState: area.city.state,
        })),
      );
  }
}

/**
 * Refuses a rectangle that is inverted or degenerate.
 *
 * The database carries the same rule as CHECK constraints; this exists so an
 * admin who swaps min and max gets a sentence rather than a constraint
 * violation. A degenerate box — zero height or width — is worth catching
 * separately because it is syntactically fine, satisfies `min <= max`, and
 * silently matches nothing forever.
 */
function assertValidBounds(bounds: AreaBounds): void {
  const problems: Array<{ field: string; message: string; code: string }> = [];

  if (!(bounds.maxLat > bounds.minLat)) {
    problems.push({
      field: 'maxLat',
      message: 'maxLat must be greater than minLat',
      code: 'BOUNDS_INVERTED',
    });
  }
  if (!(bounds.maxLng > bounds.minLng)) {
    problems.push({
      field: 'maxLng',
      message: 'maxLng must be greater than minLng',
      code: 'BOUNDS_INVERTED',
    });
  }

  if (problems.length > 0) {
    throw apiError(
      `The bounds for ${bounds.name} are not a rectangle`,
      HttpStatus.BAD_REQUEST,
      problems,
    );
  }
}
