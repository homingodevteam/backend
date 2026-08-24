// Script to directly approve a Pro by phone number, bypassing the application process
// Usage: npx tsx scripts/approve-pro.ts

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/client';

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set in .env');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const PHONE = '+919406879532';

async function main() {
  // 1. Find the Pro
  const pro = await prisma.pro.findFirst({ where: { phone: PHONE } });

  if (!pro) {
    console.log(`❌ No Pro found with phone: ${PHONE}`);
    return;
  }

  console.log(`✅ Found Pro:`);
  console.log(`   ID: ${pro.id}`);
  console.log(`   Name: ${pro.fullName}`);
  console.log(`   Phone: ${pro.phone}`);
  console.log(`   Current Status: ${pro.status}`);

  // 2. Check if already approved
  if (pro.status === 'approved') {
    console.log('\nℹ️  Pro is already approved. No changes needed.');
    return;
  }

  // 3. Generate employee code if missing
  let employeeCode = pro.employeeCode;
  if (!employeeCode) {
    const count = await prisma.pro.count();
    employeeCode = `PRO${String(count + 1).padStart(4, '0')}`;
    console.log(`\n   Generated employee code: ${employeeCode}`);
  }

  // 4. Directly update the Pro status to 'approved', bypassing the full application flow.
  //    We skip creating an application record to avoid DB check constraints.
  const updatedPro = await prisma.pro.update({
    where: { id: pro.id },
    data: {
      status: 'approved',
      approvedAt: new Date(),
      employeeCode,
      // Set name/dob/gender if missing so the Pro can function properly
      fullName: pro.fullName ?? 'Pro User',
      dateOfBirth: pro.dateOfBirth ?? new Date('1990-01-01'),
      gender: pro.gender ?? 'male',
    },
  });

  console.log(`\n🎉 Pro approved successfully!`);
  console.log(`   Name: ${updatedPro.fullName}`);
  console.log(`   Phone: ${updatedPro.phone}`);
  console.log(`   Status: ${updatedPro.status}`);
  console.log(`   Employee Code: ${updatedPro.employeeCode}`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
