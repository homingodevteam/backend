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
    ops: ['pro.application.review', 'pro.moderate', 'pro.availability.set'],
    support: ['customer.moderate'],
    finance: [],
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

  console.log(`Seeded four system roles and admin user (${SEED_ADMIN_PHONE}).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
