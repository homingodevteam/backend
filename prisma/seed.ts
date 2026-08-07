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

/**
 * There is no public admin signup — every AdminUser is provisioned by an
 * existing admin. This creates the first one so there's someone who can.
 *
 * The phone number here is a real number given at seed time, explicitly
 * flagged as temporary — swap it via `PATCH /admin/admin-users/:id` (or by
 * re-running this seed after editing SEED_ADMIN_PHONE) once a permanent
 * super-admin phone is decided.
 */
const SEED_ADMIN_PHONE = '+916266941709';

async function main(): Promise<void> {
  const role = await prisma.role.upsert({
    where: { name: 'super_admin' },
    update: { permissionCodes: ALL_PERMISSION_CODES },
    create: {
      name: 'super_admin',
      description: 'Full platform access — seeded, do not delete',
      permissionCodes: ALL_PERMISSION_CODES,
      isSystemRole: true,
    },
  });

  await prisma.adminUser.upsert({
    where: { phone: SEED_ADMIN_PHONE },
    update: { roleId: role.id },
    create: {
      phone: SEED_ADMIN_PHONE,
      fullName: 'Super Admin',
      roleId: role.id,
      isActive: true,
    },
  });

  console.log(`Seeded super_admin role and admin user (${SEED_ADMIN_PHONE}).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
