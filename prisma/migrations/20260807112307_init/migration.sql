-- CreateTable
CREATE TABLE "cities" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissionCodes" JSONB NOT NULL DEFAULT '[]',
    "isSystemRole" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "phone" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "roleId" UUID NOT NULL,
    "cityScopeJson" JSONB NOT NULL DEFAULT '[]',
    "pushToken" TEXT,
    "pushPlatform" TEXT,
    "pushTokenUpdatedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "adminUserId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ipAddress" TEXT,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deviceId" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "fullName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'guest',
    "verifiedAt" TIMESTAMP(3),
    "razorpayCustomerId" TEXT,
    "pushToken" TEXT,
    "pushPlatform" TEXT,
    "pushTokenUpdatedAt" TIMESTAMP(3),
    "defaultAddressId" UUID,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "customerId" UUID NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'other',
    "addressLine" TEXT NOT NULL,
    "landmark" TEXT,
    "pinLat" DOUBLE PRECISION NOT NULL,
    "pinLng" DOUBLE PRECISION NOT NULL,
    "geoPoint" JSONB,
    "cityId" UUID NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pros" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "phone" TEXT NOT NULL,
    "fullName" TEXT,
    "email" TEXT,
    "employeeCode" TEXT,
    "monthlySalary" DECIMAL(12,2),
    "salaryUpdatedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'applied',
    "approvedApplicationId" UUID,
    "isAvailable" BOOLEAN NOT NULL DEFAULT false,
    "availabilityUpdatedAt" TIMESTAMP(3),
    "pushToken" TEXT,
    "pushPlatform" TEXT,
    "pushTokenUpdatedAt" TIMESTAMP(3),
    "homeBaseLat" DOUBLE PRECISION,
    "homeBaseLng" DOUBLE PRECISION,
    "lastKnownLat" DOUBLE PRECISION,
    "lastKnownLng" DOUBLE PRECISION,
    "lastLocationAt" TIMESTAMP(3),
    "cityId" UUID,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "assignmentsOffered" INTEGER NOT NULL DEFAULT 0,
    "assignmentsAcknowledged" INTEGER NOT NULL DEFAULT 0,
    "acceptanceRate" DOUBLE PRECISION,
    "completedJobs" INTEGER NOT NULL DEFAULT 0,
    "countersRebuiltAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "pros_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pro_applications" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "proId" UUID NOT NULL,
    "referredByType" TEXT NOT NULL DEFAULT 'none',
    "referredById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "queueStatus" TEXT NOT NULL DEFAULT 'pending',
    "aadhaarSource" TEXT,
    "aadhaarUrl" TEXT,
    "aadhaarNumberMasked" TEXT,
    "aadhaarStatus" TEXT NOT NULL DEFAULT 'pending',
    "aadhaarVerifiedByAdminId" TEXT,
    "aadhaarVerifiedAt" TIMESTAMP(3),
    "aadhaarRejectionReason" TEXT,
    "panSource" TEXT,
    "panUrl" TEXT,
    "panNumberMasked" TEXT,
    "panStatus" TEXT NOT NULL DEFAULT 'pending',
    "panVerifiedByAdminId" TEXT,
    "panVerifiedAt" TIMESTAMP(3),
    "panRejectionReason" TEXT,
    "digilockerRequestId" TEXT,
    "digilockerFetchedAt" TIMESTAMP(3),
    "reviewedByAdminId" TEXT,
    "verificationCallAt" TIMESTAMP(3),
    "decision" TEXT,
    "decisionAt" TIMESTAMP(3),
    "rejectionReason" TEXT,

    CONSTRAINT "pro_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pro_services" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "proId" UUID NOT NULL,
    "serviceId" TEXT NOT NULL,
    "proficiency" TEXT NOT NULL DEFAULT 'trainee',
    "certifiedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pro_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pro_bank_accounts" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "proId" UUID NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "accountNumberMasked" TEXT NOT NULL,
    "ifscCode" TEXT NOT NULL,
    "upiId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pro_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cities_isActive_idx" ON "cities"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_phone_key" ON "admin_users"("phone");

-- CreateIndex
CREATE INDEX "admin_audit_logs_adminUserId_idx" ON "admin_audit_logs"("adminUserId");

-- CreateIndex
CREATE INDEX "admin_audit_logs_entityType_idx" ON "admin_audit_logs"("entityType");

-- CreateIndex
CREATE INDEX "admin_audit_logs_entityId_idx" ON "admin_audit_logs"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_deviceId_key" ON "customers"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "customers_razorpayCustomerId_key" ON "customers"("razorpayCustomerId");

-- CreateIndex
CREATE INDEX "customer_addresses_customerId_idx" ON "customer_addresses"("customerId");

-- CreateIndex
CREATE INDEX "customer_addresses_cityId_idx" ON "customer_addresses"("cityId");

-- CreateIndex
CREATE UNIQUE INDEX "pros_phone_key" ON "pros"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "pros_employeeCode_key" ON "pros"("employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "pros_approvedApplicationId_key" ON "pros"("approvedApplicationId");

-- CreateIndex
CREATE INDEX "pros_status_idx" ON "pros"("status");

-- CreateIndex
CREATE INDEX "pros_isAvailable_idx" ON "pros"("isAvailable");

-- CreateIndex
CREATE INDEX "pros_cityId_idx" ON "pros"("cityId");

-- CreateIndex
CREATE INDEX "pro_applications_proId_idx" ON "pro_applications"("proId");

-- CreateIndex
CREATE INDEX "pro_applications_queueStatus_idx" ON "pro_applications"("queueStatus");

-- CreateIndex
CREATE INDEX "pro_services_proId_idx" ON "pro_services"("proId");

-- CreateIndex
CREATE INDEX "pro_services_serviceId_idx" ON "pro_services"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "pro_services_proId_serviceId_key" ON "pro_services"("proId", "serviceId");

-- CreateIndex
CREATE INDEX "pro_bank_accounts_proId_idx" ON "pro_bank_accounts"("proId");

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pros" ADD CONSTRAINT "pros_approvedApplicationId_fkey" FOREIGN KEY ("approvedApplicationId") REFERENCES "pro_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pros" ADD CONSTRAINT "pros_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pro_applications" ADD CONSTRAINT "pro_applications_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pro_services" ADD CONSTRAINT "pro_services_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pro_bank_accounts" ADD CONSTRAINT "pro_bank_accounts_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE CASCADE ON UPDATE CASCADE;
