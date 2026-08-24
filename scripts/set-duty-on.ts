import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const PHONE = '+919406879532';

async function main() {
  const pro = await prisma.pro.findFirst({ where: { phone: PHONE } });

  if (!pro) {
    console.log(`❌ No Pro found with phone: ${PHONE}`);
    return;
  }

  console.log(`✅ Found Pro:`);
  console.log(`   Name: ${pro.fullName}`);
  console.log(`   Phone: ${pro.phone}`);
  console.log(`   Status: ${pro.status}`);
  console.log(`   On Duty (isAvailable): ${pro.isAvailable}`);

  if (pro.isAvailable) {
    console.log('\nℹ️  Pro is already on duty. No changes needed.');
    return;
  }

  const updated = await prisma.pro.update({
    where: { id: pro.id },
    data: { isAvailable: true },
  });

  console.log(`\n🟢 Duty turned ON successfully!`);
  console.log(`   Name: ${updated.fullName}`);
  console.log(`   Phone: ${updated.phone}`);
  console.log(`   On Duty: ${updated.isAvailable}`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
