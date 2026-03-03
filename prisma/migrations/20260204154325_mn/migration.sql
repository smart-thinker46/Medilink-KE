/*
  Warnings:

  - You are about to drop the `ambulance_dispatches` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `appointments` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `beds` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `bill_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `bills` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `blood_stock` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `dispense_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `dispenses` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `emergency_cases` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `inpatients` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `inventory_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `lab_requests` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `lab_results` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `meal_orders` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `medical_records` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `medication_administrations` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `mortuary_records` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `notifications` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `nursing_notes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ot_bookings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `patients` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `payments` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `pharmacy_order_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `pharmacy_orders` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `prescription_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `prescriptions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `purchase_orders` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `radiology_reports` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `radiology_requests` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `shifts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `staff` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `suppliers` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `survey_responses` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `teleconsultations` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `visits` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vitals` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `wards` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'HOSPITAL_ADMIN', 'PHARMACY_ADMIN', 'MEDIC', 'PATIENT');

-- CreateEnum
CREATE TYPE "TenantType" AS ENUM ('HOSPITAL', 'PHARMACY');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('BASIC', 'PREMIUM', 'ENTERPRISE');

-- DropForeignKey
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_medicId_fkey";

-- DropForeignKey
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_patientId_fkey";

-- DropForeignKey
ALTER TABLE "beds" DROP CONSTRAINT "beds_wardId_fkey";

-- DropForeignKey
ALTER TABLE "bill_items" DROP CONSTRAINT "bill_items_billId_fkey";

-- DropForeignKey
ALTER TABLE "bills" DROP CONSTRAINT "bills_patientId_fkey";

-- DropForeignKey
ALTER TABLE "dispense_items" DROP CONSTRAINT "dispense_items_dispenseId_fkey";

-- DropForeignKey
ALTER TABLE "dispense_items" DROP CONSTRAINT "dispense_items_inventoryItemId_fkey";

-- DropForeignKey
ALTER TABLE "dispenses" DROP CONSTRAINT "dispenses_prescriptionId_fkey";

-- DropForeignKey
ALTER TABLE "inpatients" DROP CONSTRAINT "inpatients_bedId_fkey";

-- DropForeignKey
ALTER TABLE "inpatients" DROP CONSTRAINT "inpatients_patientId_fkey";

-- DropForeignKey
ALTER TABLE "inpatients" DROP CONSTRAINT "inpatients_wardId_fkey";

-- DropForeignKey
ALTER TABLE "lab_requests" DROP CONSTRAINT "lab_requests_patientId_fkey";

-- DropForeignKey
ALTER TABLE "lab_results" DROP CONSTRAINT "lab_results_labRequestId_fkey";

-- DropForeignKey
ALTER TABLE "medical_records" DROP CONSTRAINT "medical_records_patientId_fkey";

-- DropForeignKey
ALTER TABLE "medical_records" DROP CONSTRAINT "medical_records_visitId_fkey";

-- DropForeignKey
ALTER TABLE "medication_administrations" DROP CONSTRAINT "medication_administrations_inpatientId_fkey";

-- DropForeignKey
ALTER TABLE "nursing_notes" DROP CONSTRAINT "nursing_notes_inpatientId_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_billId_fkey";

-- DropForeignKey
ALTER TABLE "pharmacy_order_items" DROP CONSTRAINT "pharmacy_order_items_inventoryItemId_fkey";

-- DropForeignKey
ALTER TABLE "pharmacy_order_items" DROP CONSTRAINT "pharmacy_order_items_orderId_fkey";

-- DropForeignKey
ALTER TABLE "pharmacy_orders" DROP CONSTRAINT "pharmacy_orders_patientId_fkey";

-- DropForeignKey
ALTER TABLE "prescription_items" DROP CONSTRAINT "prescription_items_prescriptionId_fkey";

-- DropForeignKey
ALTER TABLE "prescriptions" DROP CONSTRAINT "prescriptions_patientId_fkey";

-- DropForeignKey
ALTER TABLE "radiology_reports" DROP CONSTRAINT "radiology_reports_requestId_fkey";

-- DropForeignKey
ALTER TABLE "radiology_requests" DROP CONSTRAINT "radiology_requests_patientId_fkey";

-- DropForeignKey
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_staffId_fkey";

-- DropForeignKey
ALTER TABLE "survey_responses" DROP CONSTRAINT "survey_responses_patientId_fkey";

-- DropForeignKey
ALTER TABLE "teleconsultations" DROP CONSTRAINT "teleconsultations_appointmentId_fkey";

-- DropForeignKey
ALTER TABLE "visits" DROP CONSTRAINT "visits_appointmentId_fkey";

-- DropForeignKey
ALTER TABLE "vitals" DROP CONSTRAINT "vitals_visitId_fkey";

-- DropTable
DROP TABLE "ambulance_dispatches";

-- DropTable
DROP TABLE "appointments";

-- DropTable
DROP TABLE "beds";

-- DropTable
DROP TABLE "bill_items";

-- DropTable
DROP TABLE "bills";

-- DropTable
DROP TABLE "blood_stock";

-- DropTable
DROP TABLE "dispense_items";

-- DropTable
DROP TABLE "dispenses";

-- DropTable
DROP TABLE "emergency_cases";

-- DropTable
DROP TABLE "inpatients";

-- DropTable
DROP TABLE "inventory_items";

-- DropTable
DROP TABLE "lab_requests";

-- DropTable
DROP TABLE "lab_results";

-- DropTable
DROP TABLE "meal_orders";

-- DropTable
DROP TABLE "medical_records";

-- DropTable
DROP TABLE "medication_administrations";

-- DropTable
DROP TABLE "mortuary_records";

-- DropTable
DROP TABLE "notifications";

-- DropTable
DROP TABLE "nursing_notes";

-- DropTable
DROP TABLE "ot_bookings";

-- DropTable
DROP TABLE "patients";

-- DropTable
DROP TABLE "payments";

-- DropTable
DROP TABLE "pharmacy_order_items";

-- DropTable
DROP TABLE "pharmacy_orders";

-- DropTable
DROP TABLE "prescription_items";

-- DropTable
DROP TABLE "prescriptions";

-- DropTable
DROP TABLE "purchase_orders";

-- DropTable
DROP TABLE "radiology_reports";

-- DropTable
DROP TABLE "radiology_requests";

-- DropTable
DROP TABLE "shifts";

-- DropTable
DROP TABLE "staff";

-- DropTable
DROP TABLE "suppliers";

-- DropTable
DROP TABLE "survey_responses";

-- DropTable
DROP TABLE "teleconsultations";

-- DropTable
DROP TABLE "visits";

-- DropTable
DROP TABLE "vitals";

-- DropTable
DROP TABLE "wards";

-- DropEnum
DROP TYPE "AppointmentStatus";

-- DropEnum
DROP TYPE "Gender";

-- DropEnum
DROP TYPE "PaymentMethod";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "fullName" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "gender" TEXT,
    "NationalIdPhotoUrl" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLogin" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "hashedRefreshToken" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medics" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "licenseNumber" TEXT NOT NULL,
    "specialization" TEXT NOT NULL,
    "experienceYears" INTEGER,
    "consultationFee" DECIMAL(65,30),
    "bio" TEXT,

    CONSTRAINT "medics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_admins" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "system_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TenantType" NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'PENDING',
    "dbUrl" TEXT,
    "registrationNumber" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "logoUrl" TEXT,
    "location" JSONB,
    "subscriptionStatus" TEXT NOT NULL DEFAULT 'active',
    "subscriptionTier" "SubscriptionTier" NOT NULL DEFAULT 'BASIC',
    "subscriptionEnd" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_users" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tenant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "tenantId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mpesa_transactions" (
    "id" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "transID" TEXT NOT NULL,
    "transTime" TEXT NOT NULL,
    "transAmount" TEXT NOT NULL,
    "businessShortCode" TEXT NOT NULL,
    "billRefNumber" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "orgAccountBalance" TEXT,
    "thirdPartyTransID" TEXT,
    "msisdn" TEXT NOT NULL,
    "firstName" TEXT,
    "middleName" TEXT,
    "lastName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,

    CONSTRAINT "mpesa_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "medics_userId_key" ON "medics"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "medics_licenseNumber_key" ON "medics"("licenseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "system_admins_userId_key" ON "system_admins"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_users_userId_tenantId_key" ON "tenant_users"("userId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_transactions_transID_key" ON "mpesa_transactions"("transID");

-- AddForeignKey
ALTER TABLE "medics" ADD CONSTRAINT "medics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_admins" ADD CONSTRAINT "system_admins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
