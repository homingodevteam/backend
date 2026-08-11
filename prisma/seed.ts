import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/client';
import { ALL_PERMISSION_CODES } from '../src/modules/identity/constants/permission-code';

const nodeEnv = process.env.NODE_ENV ?? 'local';
loadEnv({ path: `.env.${nodeEnv}` });
loadEnv({ path: '.env' });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Bootstrap only. All later admin accounts are provisioned by an admin API.
const SEED_ADMIN_PHONE = '+916266941709';

async function main(): Promise<void> {
  const definitions = {
    ops: [
      'pro.application.review',
      'pro.moderate',
      'pro.availability.set',
      'catalog.manage',
      'catalog.city.manage',
      'booking.read',
      'booking.cancel',
      'dispatch.override',
      // Ops counts the cash a Pro hands back; ops cannot refund a customer.
      'payment.cash.handover.confirm',
    ],
    // Support handles the cases a customer cannot self-serve: a mid-job stop
    // (window E) and the door-step OTP override.
    support: [
      'customer.moderate',
      'booking.read',
      'booking.cancel',
      'booking.force_start',
      // Support answers "where is my money" and needs to see an order and its
      // attempts. It cannot send money back.
      'payment.read',
    ],
    // Commission rates are finance's call, not ops' — see US-3.10 / US-8.4.
    // Money leaving the platform is the same kind of call.
    finance: ['catalog.commission.set', 'payment.read', 'payment.refund'],
    super_admin: ALL_PERMISSION_CODES,
  } as const;

  const roles = await Promise.all(
    Object.entries(definitions).map(([name, permissionCodes]) =>
      prisma.role.upsert({
        where: { name },
        update: { permissionCodes: [...permissionCodes], isSystemRole: true },
        create: {
          name,
          description: `${name} system role`,
          permissionCodes: [...permissionCodes],
          isSystemRole: true,
        },
      }),
    ),
  );
  const superAdmin = roles.find((role) => role.name === 'super_admin')!;

  await prisma.adminUser.upsert({
    where: { phone: SEED_ADMIN_PHONE },
    update: { roleId: superAdmin.id },
    create: {
      phone: SEED_ADMIN_PHONE,
      fullName: 'Super Admin',
      roleId: superAdmin.id,
      isActive: true,
    },
  });

  await seedCatalog();

  console.log(`Seeded four system roles and admin user (${SEED_ADMIN_PHONE}).`);
}

/**
 * A minimal but realistic catalogue, so Booking, Dispatch and Commission have
 * something to point at before their own modules exist. Ids are fixed so
 * re-running the seed is idempotent and so integration tests can hard-code
 * them.
 */
async function seedCatalog(): Promise<void> {
  const cities = [
    {
      id: '00000000-0000-4000-9000-000000000001',
      name: 'Indore',
      state: 'Madhya Pradesh',
    },
    {
      id: '00000000-0000-4000-9000-000000000002',
      name: 'Bhopal',
      state: 'Madhya Pradesh',
    },
  ];

  for (const city of cities) {
    await prisma.city.upsert({
      where: { id: city.id },
      update: { name: city.name, state: city.state, isActive: true },
      create: { ...city, timezone: 'Asia/Kolkata', isActive: true },
    });
  }

  // parentSlug is resolved against the roots seeded in the same pass. Two
  // levels only — see CONFLICTS_AND_DECISIONS #10.
  const categories = [
    {
      id: '00000000-0000-4000-a000-000000000001',
      slug: 'home-cleaning',
      name: 'Home Cleaning',
      sortOrder: 1,
      parentSlug: null,
    },
    {
      id: '00000000-0000-4000-a000-000000000002',
      slug: 'appliance-repair',
      name: 'Appliance Repair',
      sortOrder: 2,
      parentSlug: null,
    },
    {
      id: '00000000-0000-4000-a000-000000000011',
      slug: 'deep-cleaning',
      name: 'Deep Cleaning',
      sortOrder: 1,
      parentSlug: 'home-cleaning',
    },
    {
      id: '00000000-0000-4000-a000-000000000012',
      slug: 'bathroom-cleaning',
      name: 'Bathroom Cleaning',
      sortOrder: 2,
      parentSlug: 'home-cleaning',
    },
    {
      id: '00000000-0000-4000-a000-000000000021',
      slug: 'ac-service',
      name: 'AC Service',
      sortOrder: 1,
      parentSlug: 'appliance-repair',
    },
  ];

  const idBySlug = new Map(categories.map((c) => [c.slug, c.id]));

  for (const { parentSlug, ...category } of categories) {
    const parentCategoryId = parentSlug
      ? (idBySlug.get(parentSlug) ?? null)
      : null;
    const data = { ...category, parentCategoryId, isActive: true };
    await prisma.serviceCategory.upsert({
      where: { id: category.id },
      update: data,
      create: data,
    });
  }

  const services = [
    {
      id: '00000000-0000-4000-b000-000000000001',
      categoryId: idBySlug.get('deep-cleaning')!,
      name: 'Full Home Deep Cleaning (2 BHK)',
      description:
        'End-to-end deep clean of a 2 BHK, including kitchen and bathrooms.',
      durationMinutes: 240,
      flatPrice: '4999.00',
      commissionType: 'percent',
      commissionValue: '30.00',
      supportsInstant: false,
      supportsScheduled: true,
      supportsRecurring: true,
    },
    {
      id: '00000000-0000-4000-b000-000000000002',
      categoryId: idBySlug.get('bathroom-cleaning')!,
      name: 'Bathroom Deep Clean',
      description: 'Single bathroom, descaling and sanitisation included.',
      durationMinutes: 60,
      flatPrice: '699.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: true,
    },
    {
      id: '00000000-0000-4000-b000-000000000003',
      categoryId: idBySlug.get('ac-service')!,
      name: 'Split AC Service',
      description:
        'Wet service of one split AC unit, filter and coil cleaning.',
      durationMinutes: 90,
      flatPrice: '599.00',
      commissionType: 'flat',
      commissionValue: '220.00',
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
    },
  ];

  for (const service of services) {
    const data = { ...service, isActive: true };
    await prisma.service.upsert({
      where: { id: service.id },
      update: data,
      create: data,
    });
  }

  await seedIndoreAreas(services.map((service) => service.id));

  console.log(
    `Seeded ${cities.length} cities, ${categories.length} categories and ${services.length} services.`,
  );
}

/**
 * Four Indore areas as a **tiled 2×2 block of ~6 km cells**.
 *
 * Note what these are not: they do not overlap, and they do not leave gaps
 * between them. Each cell's northern edge is the next cell's southern edge —
 * the *same number*, not a near-miss — which is exactly what the half-open
 * bounds rely on. A pin on the boundary resolves to precisely one cell.
 *
 * The names are real neighbourhoods so the fixtures read sensibly, but the
 * geometry is a grid, which is what the generator produces and what ops then
 * renames. See CONFLICTS_AND_DECISIONS #42.
 *
 * Every service is on in every area **except** Rau, which is deliberately left
 * without the deep clean — so there is a working example of
 * `SERVICE_NOT_AVAILABLE_IN_AREA` to develop and demo against rather than a
 * uniformly-available map that makes the whole feature look inert.
 */
async function seedIndoreAreas(serviceIds: string[]): Promise<void> {
  const INDORE = '00000000-0000-4000-9000-000000000001';
  const DEEP_CLEAN = '00000000-0000-4000-b000-000000000001';

  // A 2×2 grid of ~6 km cells around central Indore. Shared edges are written
  // once as constants so the tiling is exact rather than approximately right.
  const LAT_S = 22.66;
  const LAT_MID = 22.714; // 6 km north of LAT_S
  const LAT_N = 22.768;
  const LNG_W = 75.8;
  const LNG_MID = 75.858; // ~6 km east of LNG_W at this latitude
  const LNG_E = 75.916;

  const areas = [
    {
      id: '00000000-0000-4000-c000-000000000001',
      name: 'Vijay Nagar',
      minLat: LAT_MID,
      maxLat: LAT_N,
      minLng: LNG_MID,
      maxLng: LNG_E,
    },
    {
      id: '00000000-0000-4000-c000-000000000002',
      name: 'Rajwada',
      minLat: LAT_MID,
      maxLat: LAT_N,
      minLng: LNG_W,
      maxLng: LNG_MID,
    },
    {
      id: '00000000-0000-4000-c000-000000000003',
      name: 'Palasia',
      minLat: LAT_S,
      maxLat: LAT_MID,
      minLng: LNG_MID,
      maxLng: LNG_E,
    },
    {
      id: '00000000-0000-4000-c000-000000000004',
      name: 'Rau',
      minLat: LAT_S,
      maxLat: LAT_MID,
      minLng: LNG_W,
      maxLng: LNG_MID,
    },
  ];

  for (const area of areas) {
    const data = { ...area, cityId: INDORE, isActive: true };
    await prisma.area.upsert({
      where: { id: area.id },
      update: data,
      create: data,
    });

    for (const serviceId of serviceIds) {
      const isActive = !(area.name === 'Rau' && serviceId === DEEP_CLEAN);
      await prisma.areaService.upsert({
        where: { areaId_serviceId: { areaId: area.id, serviceId } },
        update: { isActive },
        create: { areaId: area.id, serviceId, isActive },
      });
    }
  }

  console.log(
    `Seeded ${areas.length} tiled Indore areas (deep clean off in Rau, for a working unavailable case).`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
