import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Search for any partial match of the phone number
  const pros = await prisma.pro.findMany({
    where: {
      phone: { contains: '9406879532' },
    },
    select: { id: true, phone: true, fullName: true, status: true },
  });

  console.log('Search results:', JSON.stringify(pros, null, 2));

  if (pros.length === 0) {
    // Show a sample of existing pros to see phone format
    const sample = await prisma.pro.findMany({
      take: 5,
      select: { id: true, phone: true, fullName: true, status: true },
    });
    console.log(
      '\nSample Pros (to check phone format):',
      JSON.stringify(sample, null, 2),
    );
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
