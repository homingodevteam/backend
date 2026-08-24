import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const pro = await prisma.pro.findFirstOrThrow({
    where: { phone: '+919406879532' },
  });

  console.log('=== PRO ===');
  console.log('id         :', pro.id);
  console.log('status     :', pro.status, '| isAvailable:', pro.isAvailable);
  console.log('cityId     :', pro.cityId);
  console.log(
    'lastKnown  :',
    pro.lastKnownLat,
    pro.lastKnownLng,
    '@',
    pro.lastLocationAt?.toISOString() ?? '-',
  );
  console.log('homeBase   :', pro.homeBaseLat, pro.homeBaseLng);

  const bookings = await prisma.booking.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: {
      service: { select: { name: true, categoryId: true } },
      assignmentCandidates: {
        include: { pro: { select: { fullName: true, phone: true } } },
      },
    },
  });

  console.log('\n=== LAST 5 BOOKINGS ===');
  for (const b of bookings) {
    console.log(
      `\n${b.bookingNumber} | status=${b.status} | ${b.service?.name}`,
    );
    console.log(`   created ${b.createdAt.toISOString()}`);
    console.log(`   slot    ${b.slotStartAt?.toISOString() ?? '(none)'}`);
    console.log(`   areaId  ${b.areaId ?? '(none)'}`);
    console.log(`   proId   ${b.proId ?? '(UNASSIGNED)'}`);
    console.log(`   serviceCategory ${b.service?.categoryId}`);
    console.log(`   candidates: ${b.assignmentCandidates.length}`);
    for (const c of b.assignmentCandidates) {
      console.log(
        `     - ${c.pro.fullName ?? c.pro.phone} attempt=${c.attemptNumber} ` +
          `rank=${c.rank ?? 'EXCLUDED'} winner=${c.isWinner} reason=${c.excludedReason ?? '-'}`,
      );
    }
  }

  const mine = await prisma.assignmentCandidate.findMany({
    where: { proId: pro.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { booking: { select: { bookingNumber: true, status: true } } },
  });

  console.log('\n=== CANDIDATE ROWS FOR MEET ===');
  if (!mine.length)
    console.log('NONE — dispatch never even considered this Pro.');
  mine.forEach((c) =>
    console.log(
      `${c.booking.bookingNumber} rank=${c.rank ?? 'EXCLUDED'} reason=${c.excludedReason ?? '-'} winner=${c.isWinner}`,
    ),
  );
}

main()
  .catch((e: unknown) =>
    console.error('ERR', e instanceof Error ? e.message : e),
  )
  .finally(() => prisma.$disconnect());
