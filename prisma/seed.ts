import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { getAuth } from 'firebase-admin/auth';
import { PrismaClient } from '../src/prisma/client';
import { buildFirebaseOptions } from '../src/config/firebase.config';
import { initFirebaseAdmin } from '../src/firebase/init-firebase-admin';
import { ALL_PERMISSION_CODES } from '../src/modules/identity/constants/permission-code';

const nodeEnv = process.env.NODE_ENV ?? 'local';
loadEnv({ path: `.env.${nodeEnv}` });
loadEnv({ path: '.env' });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Bootstrap only. All later admin accounts are provisioned by an admin API.
const SEED_ADMIN_PHONE = '+916266941709';
const SEED_ADMIN_EMAIL = 'superadmin@homingo.dev';
// Dev-only fixed password — change it via the admin console once real
// people are using this environment. Never used in production seeding.
const SEED_ADMIN_PASSWORD = 'Homingo#SuperAdmin1';

/** Idempotent: reuses the Firebase user if this seed already ran once. */
async function ensureFirebaseUser(): Promise<string> {
  const options = buildFirebaseOptions({
    NODE_ENV: nodeEnv,
    FIREBASE_SERVICE_ACCOUNT_PATH: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
  });
  const auth = getAuth(initFirebaseAdmin(options.serviceAccountPath));

  try {
    const existing = await auth.getUserByEmail(SEED_ADMIN_EMAIL);
    return existing.uid;
  } catch {
    const created = await auth.createUser({
      email: SEED_ADMIN_EMAIL,
      password: SEED_ADMIN_PASSWORD,
      displayName: 'Super Admin',
    });
    return created.uid;
  }
}

async function main(): Promise<void> {
  const firebaseUid = await ensureFirebaseUser();
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
      // A one-star spree is a roster problem before it is a content problem,
      // so ops can hide review text too — it never moves the score either way.
      'pro.review.moderate',
    ],
    // Support handles the cases a customer cannot self-serve: a mid-job stop
    // (window E) and the door-step OTP override.
    support: [
      'customer.moderate',
      'booking.read',
      'booking.cancel',
      'booking.force_start',
      'pro.review.moderate',
    ],
    // Commission rates are finance's call, not ops' — see US-3.10 / US-8.4.
    // Bank details belong to the same owner for the same reason.
    finance: ['catalog.commission.set', 'pro.bankAccount.verify'],
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
    update: { roleId: superAdmin.id, email: SEED_ADMIN_EMAIL, firebaseUid },
    create: {
      phone: SEED_ADMIN_PHONE,
      fullName: 'Super Admin',
      email: SEED_ADMIN_EMAIL,
      firebaseUid,
      roleId: superAdmin.id,
      isActive: true,
    },
  });

  await seedCatalog();

  console.log(
    `Seeded four system roles and admin user (${SEED_ADMIN_PHONE}, ${SEED_ADMIN_EMAIL}).`,
  );
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

  console.log(
    `Seeded ${cities.length} cities, ${categories.length} categories and ${services.length} services.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
