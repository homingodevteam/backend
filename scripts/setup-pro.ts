import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const PHONE = '+919406879532';

// Category IDs for cleaning and appliance
const CLEANING_CATEGORY_ID = '00000000-0000-4000-a000-000000000001';
const APPLIANCE_CATEGORY_ID = '00000000-0000-4000-a000-000000000002';

async function main() {
  // 1. Find the Pro
  const pro = await prisma.pro.findFirst({ where: { phone: PHONE } });
  if (!pro) {
    console.log(`❌ No Pro found with phone: ${PHONE}`);
    return;
  }
  console.log(`✅ Found Pro: ${pro.fullName} (${pro.phone})`);

  // 2. Update name and email
  const updated = await prisma.pro.update({
    where: { id: pro.id },
    data: {
      fullName: 'Meet Roj',
      email: 'meetroj512@gmail.com',
    },
  });
  console.log(`\n✅ Updated profile:`);
  console.log(`   Name:  ${updated.fullName}`);
  console.log(`   Email: ${updated.email}`);

  // 3. Fetch all cleaning and appliance services
  const services = await prisma.service.findMany({
    where: {
      categoryId: { in: [CLEANING_CATEGORY_ID, APPLIANCE_CATEGORY_ID] },
    },
    select: { id: true, name: true, categoryId: true },
  });

  console.log(`\n📋 Found ${services.length} services to assign:`);
  services.forEach((s) =>
    console.log(
      `   - ${s.name} (${s.categoryId === CLEANING_CATEGORY_ID ? 'Cleaning' : 'Appliance'})`,
    ),
  );

  // 4. Assign each service (skip if already assigned)
  let assigned = 0;
  let skipped = 0;

  for (const service of services) {
    const existing = await prisma.proService.findFirst({
      where: { proId: pro.id, serviceId: service.id },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await prisma.proService.create({
      data: {
        proId: pro.id,
        serviceId: service.id,
        isActive: true,
      },
    });
    assigned++;
  }

  console.log(`\n🎉 Done!`);
  console.log(`   Services assigned: ${assigned}`);
  console.log(`   Already existed:   ${skipped}`);
  console.log(`\n✅ Pro is fully set up:`);
  console.log(`   Name:     Meet Roj`);
  console.log(`   Email:    meetroj512@gmail.com`);
  console.log(`   Phone:    ${PHONE}`);
  console.log(`   Services: Cleaning + Appliance`);
  console.log(`   Status:   approved & on duty`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
