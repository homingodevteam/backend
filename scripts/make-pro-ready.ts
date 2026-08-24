/**
 * Make one Pro fully dispatchable, from whatever state they are in.
 *
 * Usage: npx tsx scripts/make-pro-ready.ts [phone]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE THE OTHER THREE SCRIPTS
 * ---------------------------------------------------------------------------
 * `approve-pro`, `setup-pro` and `set-duty-on` each do a part of this, and the
 * parts do not add up on their own: `setup-pro` assigns the services and then
 * prints "approved & on duty" without setting either, so a Pro set up with it
 * alone is neither. Three scripts in the right order also leaves nothing that
 * checks the result.
 *
 * This is the whole job in one place, and it verifies the gates by reading the
 * row back rather than trusting that the writes above it did not throw.
 *
 * ---------------------------------------------------------------------------
 * THE THREE GATES
 * ---------------------------------------------------------------------------
 * Dispatch will not consider a Pro until all three are true, and each is a
 * separate write that ops normally performs from the admin web:
 *
 *   status === 'approved'      the KYC decision
 *   isAvailable === true       on duty
 *   activeServiceCount > 0     at least one assigned service
 *
 * A Pro missing any one of them sits waiting for jobs that never arrive, which
 * is why this refuses to report success until it has verified all three by
 * reading the row back.
 *
 * ---------------------------------------------------------------------------
 * THIS WRITES DIRECTLY TO THE DATABASE
 * ---------------------------------------------------------------------------
 * It bypasses the admin API, and with it the audit trail an admin decision
 * leaves (`decidedByAdminId`, the application record, the notification). That
 * is acceptable for a development handset and is not how a real Pro should be
 * approved — use the admin web for that.
 *
 * Idempotent: every step checks before it writes, so running it twice is safe
 * and the second run reports "already".
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set in .env');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/** Defaults to the development handset. Pass a number to target another. */
const RAW_PHONE = process.argv[2] ?? '9406879532';

/** Identity, matching the `setup-pro` script this consolidates. */
const FULL_NAME = 'Meet Roj';
const EMAIL = 'meetroj512@gmail.com';

/**
 * Which services to assign.
 *
 * Cleaning and appliance only, deliberately — the catalogue holds sixty-two
 * services across ten categories and this Pro is set up for two of them, the
 * same pair `setup-pro` picked. Bookings outside these categories will not be
 * offered, which is the intended scope rather than an omission.
 *
 * Empty this array to assign the whole catalogue instead.
 */
const CATEGORY_IDS = [
  '00000000-0000-4000-a000-000000000001', // Cleaning
  '00000000-0000-4000-a000-000000000002', // Appliance
];

/**
 * `+91` unless one is already there.
 *
 * The column stores E.164 and the app sends a bare ten digits, so a script
 * given either has to normalise or it silently finds nobody.
 */
const toE164 = (phone: string) => {
  const digits = phone.replace(/\D/g, '');
  const ten = digits.slice(-10);
  return `+91${ten}`;
};

const PHONE = toE164(RAW_PHONE);

async function main() {
  console.log(`\n🔎 Pro ${PHONE}\n`);

  const pro = await prisma.pro.findFirst({ where: { phone: PHONE } });

  if (!pro) {
    console.error(`❌ No Pro with phone ${PHONE}.`);
    console.error(
      '   The row is created the first time that number verifies an OTP in ' +
        'the app — sign in on the handset once, then run this again.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('   before:');
  console.log(`     id           ${pro.id}`);
  console.log(`     name         ${pro.fullName ?? '(none)'}`);
  console.log(`     status       ${pro.status}`);
  console.log(`     isAvailable  ${pro.isAvailable}`);
  console.log(`     city         ${pro.cityId ?? '(none)'}`);

  /*
   * 1 · Identity and approval.
   *
   * `dateOfBirth` and `gender` are filled only when missing: they are copied
   * from the KYC application on a real approval, and overwriting a value the
   * applicant actually gave would be worse than leaving it.
   */
  const employeeCode =
    pro.employeeCode ??
    `PRO${String(await prisma.pro.count()).padStart(4, '0')}`;

  await prisma.pro.update({
    where: { id: pro.id },
    data: {
      fullName: FULL_NAME,
      email: pro.email ?? EMAIL,
      status: 'approved',
      approvedAt: pro.approvedAt ?? new Date(),
      employeeCode,
      dateOfBirth: pro.dateOfBirth ?? new Date('1995-01-01'),
      gender: pro.gender ?? 'male',
      // GATE 2. Ops-owned in production — see the note at the top.
      isAvailable: true,
      availabilityUpdatedAt: new Date(),
    },
  });

  console.log('\n✅ approved, named, and on duty');

  /*
   * 2 · A city, if there is one to give.
   *
   * Not one of the three gates, but dispatch is city-scoped: a Pro with no
   * city is approved, available and still matches no booking. Only set when
   * missing, and only when the catalogue has an active city to point at.
   */
  if (!pro.cityId) {
    const city = await prisma.city.findFirst({
      where: { isActive: true },
      select: { id: true, name: true },
    });

    if (city) {
      await prisma.pro.update({
        where: { id: pro.id },
        data: { cityId: city.id },
      });
      console.log(`✅ city set to ${city.name}`);
    } else {
      console.log(
        '⚠️  no active city in the catalogue — dispatch is city-scoped',
      );
    }
  }

  /*
   * 3 · The services for the chosen categories.
   *
   * `proficiency` is set to `expert` so nothing ranks this Pro down, and
   * `certifiedAt` is stamped because an assigned service with no certification
   * date reads as pending in the admin web.
   */
  const services = await prisma.service.findMany({
    where: CATEGORY_IDS.length
      ? { categoryId: { in: CATEGORY_IDS } }
      : undefined,
    select: { id: true, name: true },
  });

  const existing = await prisma.proService.findMany({
    where: { proId: pro.id },
    select: { id: true, serviceId: true, isActive: true },
  });

  const held = new Map(existing.map((row) => [row.serviceId, row]));

  let created = 0;
  let reactivated = 0;

  for (const service of services) {
    const current = held.get(service.id);

    if (!current) {
      await prisma.proService.create({
        data: {
          proId: pro.id,
          serviceId: service.id,
          isActive: true,
          proficiency: 'expert',
          certifiedAt: new Date(),
        },
      });
      created += 1;
      continue;
    }

    // Already assigned but suspended — an inactive row does not count toward
    // `activeServiceCount`, so it has to be switched back on rather than
    // skipped as "already there".
    if (!current.isActive) {
      await prisma.proService.update({
        where: { id: current.id },
        data: { isActive: true },
      });
      reactivated += 1;
    }
  }

  console.log(
    `✅ services: ${created} assigned, ${reactivated} re-activated, ` +
      `${services.length - created - reactivated} already active ` +
      `(${services.length} in scope)`,
  );

  /*
   * 4 · Read it back.
   *
   * The point of the script is the three gates, so they are verified from the
   * database rather than assumed from the writes above having not thrown.
   */
  const after = await prisma.pro.findUniqueOrThrow({
    where: { id: pro.id },
    select: {
      fullName: true,
      status: true,
      isAvailable: true,
      cityId: true,
      employeeCode: true,
    },
  });

  const activeServices = await prisma.proService.count({
    where: { proId: pro.id, isActive: true },
  });

  const gates = [
    ['status === approved', after.status === 'approved'],
    ['isAvailable === true', after.isAvailable === true],
    ['activeServiceCount > 0', activeServices > 0],
  ] as const;

  console.log('\n   after:');
  console.log(`     name         ${after.fullName}`);
  console.log(`     status       ${after.status}`);
  console.log(`     isAvailable  ${after.isAvailable}`);
  console.log(`     employeeCode ${after.employeeCode}`);
  console.log(`     city         ${after.cityId ?? '(none)'}`);
  console.log(`     services     ${activeServices} active`);

  console.log('\n   dispatch gates:');
  for (const [label, ok] of gates) {
    console.log(`     ${ok ? '✅' : '❌'} ${label}`);
  }

  const ready = gates.every(([, ok]) => ok);

  if (!ready) {
    console.error('\n❌ Not dispatchable — a gate above is still closed.');
    process.exitCode = 1;
    return;
  }

  console.log('\n🎉 Dispatchable. This Pro can now be offered bookings.');

  if (!after.cityId) {
    console.log(
      '\n⚠️  No city set. The three gates are green, but dispatch is ' +
        'city-scoped and will not match bookings without one.',
    );
  }
}

main()
  .catch((error) => {
    console.error('❌ Failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
