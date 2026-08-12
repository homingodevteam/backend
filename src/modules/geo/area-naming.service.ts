import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { GEOCODER, type GeocoderPort } from '../../geocoding/geocoding.types';
import { boxCenter } from './geo.types';

export interface NamingProgress {
  cityId: string;
  /** Cells still carrying a generated placeholder like `C3`. */
  pending: number;
  suggested: number;
  failed: number;
  running: boolean;
}

/**
 * Turns a freshly generated grid from thirty-six mystery squares into a list an
 * admin can review.
 *
 * ## The problem this solves
 *
 * `generateGrid` names cells by position — `A1`, `C3` — because it has no idea
 * what is on the ground. Until now an admin's only way to find out was to copy
 * four coordinates into Google Maps, once per cell. For a 6×6 grid that is
 * thirty-six manual lookups per city, and the step where somebody mislabels a
 * cell and finds out when bookings go to the wrong Pros.
 *
 * So: reverse-geocode each cell's centre and pre-fill a **suggestion**. The
 * admin reviews and overrides rather than researching from scratch.
 *
 * ## Why it runs in the background
 *
 * The geocoder honours Nominatim's public-usage policy — one request per
 * second, enforced globally in Redis (that limit is module 2's, and correct).
 * Thirty-six cells is therefore at least thirty-six seconds, which is not a
 * request anyone should hold open. The route starts the pass and returns; the
 * admin polls the area list and watches names fill in.
 *
 * ## Why it cannot clobber
 *
 * It only ever touches rows whose `nameSource` is still `generated`. A name a
 * human typed is `manual` and is never a candidate, so re-running the pass — or
 * running it while an admin is halfway through renaming — is safe.
 */
@Injectable()
export class AreaNamingService {
  private readonly logger = new Logger(AreaNamingService.name);

  /** Cities with a pass in flight, so two admins cannot double-spend the
   *  geocoder's one-per-second budget on the same grid. */
  private readonly running = new Set<string>();

  /**
   * Gap between geocoder calls, **taken from whichever provider is wired**.
   *
   * Nominatim's public policy is one request per second for the whole
   * application, and its Redis lock *rejects* a second call inside the same
   * second rather than queueing — so pacing is cheaper than burning the budget
   * on 503s. Google has a paid quota and no politeness interval, so the same
   * 36-cell pass drops from over half a minute to a few seconds purely by
   * configuring a key.
   *
   * Overridable so specs need not wait real seconds to prove the loop keeps
   * going after a failure.
   */
  paceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(GEOCODER) private readonly geocoder: GeocoderPort,
  ) {
    this.paceMs = geocoder.minIntervalMs;
  }

  async progressFor(cityId: string): Promise<NamingProgress> {
    const [pending, suggested] = await Promise.all([
      this.prisma.area.count({ where: { cityId, nameSource: 'generated' } }),
      this.prisma.area.count({ where: { cityId, nameSource: 'geocoded' } }),
    ]);

    return {
      cityId,
      pending,
      suggested,
      failed: 0,
      running: this.running.has(cityId),
    };
  }

  /**
   * Starts a naming pass and returns immediately.
   *
   * @returns how many cells the pass will attempt
   */
  async start(cityId: string): Promise<{ queued: number; running: boolean }> {
    if (this.running.has(cityId)) {
      throw apiError(
        'A naming pass is already running for this city',
        HttpStatus.CONFLICT,
        [
          {
            field: 'cityId',
            message: 'Wait for it to finish, or poll the progress endpoint',
            code: 'NAMING_ALREADY_RUNNING',
          },
        ],
      );
    }

    const queued = await this.prisma.area.count({
      where: { cityId, nameSource: 'generated' },
    });
    if (queued === 0) {
      return { queued: 0, running: false };
    }

    this.running.add(cityId);
    // Deliberately not awaited. The caller gets a count and a 202; the work
    // outlives the request because it is rate-limited into the minutes.
    void this.run(cityId).finally(() => this.running.delete(cityId));

    return { queued, running: true };
  }

  private async run(cityId: string): Promise<void> {
    const cells = await this.prisma.area.findMany({
      where: { cityId, nameSource: 'generated' },
      orderBy: { gridRef: 'asc' },
    });

    this.logger.log(
      `Naming ${cells.length} generated cells in city ${cityId}. ` +
        'Rate-limited to roughly one per second by the geocoder.',
    );

    let named = 0;
    let failed = 0;

    for (const cell of cells) {
      const centre = boxCenter(cell);

      try {
        const geocoded = await this.geocoder.reverseGeocode(
          centre.lat,
          centre.lng,
        );
        const suggestion = this.pickName(geocoded.addressLine);
        if (!suggestion) {
          failed += 1;
          continue;
        }

        // Re-checked inside the loop, not just at selection: a pass takes
        // minutes, and an admin renaming a cell midway through must win.
        const updated = await this.prisma.area.updateMany({
          where: { id: cell.id, nameSource: 'generated' },
          data: {
            name: await this.deduplicate(cityId, suggestion, cell.id),
            nameSource: 'geocoded',
          },
        });
        if (updated.count > 0) named += 1;
      } catch (error) {
        // One unreachable cell must not abandon the other thirty-five. The
        // row keeps its placeholder and the next pass retries it.
        failed += 1;
        this.logger.warn(
          `Could not name cell ${cell.gridRef ?? cell.id}: ` +
            (error instanceof Error ? error.message : 'unknown error'),
        );
      }

      await new Promise((resolve) => setTimeout(resolve, this.paceMs));
    }

    this.logger.log(
      `Naming pass for city ${cityId} finished: ${named} suggested, ${failed} left as placeholders.`,
    );
  }

  /**
   * Nominatim returns a full address line — "Vijay Nagar, Indore, Madhya
   * Pradesh, India". The first component is the locality, which is the part an
   * admin recognises; the rest is the city and country they already know.
   *
   * Google returns the same field shaped differently. Where a pin sits between
   * settlements — which a grid cell centre very often does — it prefixes a
   * **Plus Code**: "22HJ+7H Brahmankhedi, Madhya Pradesh, India", or just
   * "WX4Q+P83" when it cannot name the place at all. Taking the first
   * component verbatim therefore produced area names like "22HJ+7H
   * Brahmankhedi" the moment a Google key was configured.
   *
   * So the code is stripped and the village name behind it survives. When the
   * code was the *whole* answer, nothing is substituted: the city name is
   * already known and would just produce "Dewas", "Dewas 2", "Dewas 3" across
   * a grid. A placeholder is the more truthful result — it keeps the cell on
   * the `pending` worklist, which is where a square nobody can identify
   * belongs.
   */
  private pickName(addressLine: string): string | null {
    const first = addressLine.split(',')[0]?.trim() ?? '';
    // Plus Codes draw from a fixed 20-character alphabet, which is what keeps
    // this from eating a real name that happens to contain a '+'.
    const name = first
      .replace(
        /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/i,
        '',
      )
      .trim();

    if (!name) return null;
    // A bare house number or plot number names nothing useful.
    if (/^\d+$/.test(name)) return null;
    return name.slice(0, 120);
  }

  /**
   * `(cityId, name)` is unique, and adjacent cells routinely geocode to the
   * same locality — a 6 km grid over a large neighbourhood will hit "Vijay
   * Nagar" twice. Suffix rather than fail: two cells both plausibly called
   * Vijay Nagar is information, and an admin can merge or rename them.
   */
  private async deduplicate(
    cityId: string,
    suggestion: string,
    selfId: string,
  ): Promise<string> {
    const clash = await this.prisma.area.findFirst({
      where: { cityId, name: suggestion, id: { not: selfId } },
      select: { id: true },
    });
    if (!clash) return suggestion;

    for (let n = 2; n <= 20; n += 1) {
      const candidate = `${suggestion} ${n}`;
      const taken = await this.prisma.area.findFirst({
        where: { cityId, name: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }

    // Twenty cells in one locality means the grid is finer than the map's
    // vocabulary. Leave the placeholder rather than inventing "Vijay Nagar 21".
    return suggestion;
  }
}
