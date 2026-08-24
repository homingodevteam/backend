// Script to directly approve a Pro by phone number, bypassing the application process
// Usage: node scripts/approve-pro.js

const { PrismaClient } = require('../generated/prisma');

const prisma = new PrismaClient();

const PHONE = '9406879532';

async function main() {
  // 1. Find the Pro
  const pro = await prisma.pro.findFirst({ where: { phone: PHONE } });

  if (!pro) {
    console.log(`❌ No Pro found with phone: ${PHONE}`);
    return;
  }

  console.log(`✅ Found Pro: ${JSON.stringify(pro, null, 2)}`);
  console.log(`\nCurrent status: ${pro.status}`);

  // 2. Check if already approved
  if (pro.status === 'approved') {
    console.log('ℹ️  Pro is already approved. No changes needed.');
    return;
  }

  // 3. Generate employee code if missing
  let employeeCode = pro.employeeCode;
  if (!employeeCode) {
    const count = await prisma.pro.count();
    employeeCode = `PRO${String(count + 1).padStart(4, '0')}`;
    console.log(`\nGenerated employee code: ${employeeCode}`);
  }

  // 4. Create a dummy approved application record
  const application = await prisma.proApplication.create({
    data: {
      proId: pro.id,
      referredByType: 'none',
      referredById: null,
      submittedAt: new Date(),
      queueStatus: 'approved',
      documentFullName: pro.fullName || 'Manual Approval',
      documentDateOfBirth: pro.dateOfBirth || new Date('1990-01-01'),
      documentGender: pro.gender || 'male',
      aadhaarSource: 'manual',
      aadhaarUrl: null,
      aadhaarNumberMasked: null,
      aadhaarStatus: 'verified',
      aadhaarVerifiedByType: 'admin',
      aadhaarVerifiedByAdminId: null,
      aadhaarVerifiedAt: new Date(),
      aadhaarRejectionReason: null,
      panSource: 'manual',
      panUrl: null,
      panNumberMasked: null,
      panStatus: 'verified',
      panVerifiedByType: 'admin',
      panVerifiedByAdminId: null,
      panVerifiedAt: new Date(),
      panRejectionReason: null,
      reviewedByAdminId: null,
      verificationCallAt: null,
      decision: 'approved',
      decisionAt: new Date(),
      rejectionReason: null,
    },
  });

  console.log(`\n✅ Created approved application: ${application.id}`);

  // 5. Update the Pro status to approved
  const updatedPro = await prisma.pro.update({
    where: { id: pro.id },
    data: {
      status: 'approved',
      approvedApplicationId: application.id,
      approvedAt: new Date(),
      employeeCode,
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
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
