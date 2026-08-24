/**
 * Give a Pro a home base, so dispatch can route from somewhere.
 *
 * Usage: npx tsx scripts/set-home-base.ts [phone] [lat] [lng]
 *
 * ---------------------------------------------------------------------------
 * WHY A PRO WITH NO HOME BASE IS SILENTLY UNDISPATCHABLE
 * ---------------------------------------------------------------------------
 * `DispatchScoringService.resolveOrigin` needs a point to measure travel from,
 * and tries three in order:
 *
 *   1. the address of their preceding committed job
 *   2. their live position, from the Redis `pros:live` GEO set
 *   3. `Pro.homeBaseLat/Lng`
 *
 * A Pro with none of the three is excluded with `excludedReason: 'unavailable'`
 * — the same reason used for a Pro with no free window, which is what makes
 * this hard to read from the outside: the row says "unavailable" while
 * `isAvailable` is plainly `true` in the database.
 *
 * A brand-new Pro has no completed jobs, so (1) is empty. (2) lives only in
 * Redis and does NOT survive a restart or a flush — `ingestLocation` writes it
 * with no TTL, but an in-memory store that is cleared loses it, and the
 * `lastKnownLat/Lng` columns it also writes are a cold fallback that
 * `resolveOrigin` deliberately does not read.
 *
 * So (3) is the only durable one, and it is the field nothing in the app or the
 * admin web currently sets. This script sets it.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const RAW_PHONE = process.argv[2] ?? '9406879532';
const PHONE = `+91${RAW_PHONE.replace(/\D/g, '').slice(-10)}`;

const LAT = process.argv[3] ? Number(process.argv[3]) : undefined;
const LNG = process.argv[4] ? Number(process.argv[4]) : undefined;

async function main() {
  const pro = await prisma.pro.findFirstOrThrow({ where: { phone: PHONE } });

  /*
   * Defaults to wherever the handset last reported.
   *
   * `lastKnownLat/Lng` is the cold flush `ingestLocation` writes beside the
   * Redis entry, so it is this Pro's real position and survives the restart
   * that emptied Redis — exactly the value that should have been available.
   */
  const lat = LAT ?? pro.lastKnownLat;
  const lng = LNG ?? pro.lastKnownLng;

  if (lat == null || lng == null) {
    console.error(
      '❌ No coordinates. Pass them explicitly, or open the app on the ' +
        'handset with location allowed so it reports a position first.',
    );
    process.exitCode = 1;
    return;
  }

  await prisma.pro.update({
    where: { id: pro.id },
    data: { homeBaseLat: lat, homeBaseLng: lng },
  });

  console.log(`✅ ${pro.fullName ?? PHONE} home base set to ${lat}, ${lng}`);
  console.log('   dispatch can now resolve an origin for this Pro.');
}

main()
  .catch((e: unknown) => {
    console.error('❌', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
