-- AlterTable
ALTER TABLE "hospital_services" ADD COLUMN     "availability" TEXT,
ADD COLUMN     "costMax" DECIMAL(65,30) DEFAULT 0,
ADD COLUMN     "costMin" DECIMAL(65,30) DEFAULT 0,
ADD COLUMN     "department" TEXT,
ADD COLUMN     "doctors" JSONB,
ADD COLUMN     "equipment" JSONB,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "address" TEXT,
ADD COLUMN     "applicationLink" TEXT,
ADD COLUMN     "applicationMethod" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "county" TEXT,
ADD COLUMN     "drugDispensingExperience" TEXT,
ADD COLUMN     "educationLevel" TEXT,
ADD COLUMN     "employerId" TEXT,
ADD COLUMN     "experienceYears" INTEGER DEFAULT 0,
ADD COLUMN     "facilityType" TEXT,
ADD COLUMN     "inventoryManagementExperience" TEXT,
ADD COLUMN     "jobCategory" TEXT,
ADD COLUMN     "licenseBody" TEXT,
ADD COLUMN     "maxApplicants" INTEGER DEFAULT 0,
ADD COLUMN     "payMax" DECIMAL(65,30) DEFAULT 0,
ADD COLUMN     "payMin" DECIMAL(65,30) DEFAULT 0,
ADD COLUMN     "pharmacySoftwareExperience" TEXT,
ADD COLUMN     "requiredDocuments" JSONB;

-- CreateIndex
CREATE INDEX "hospital_services_category_idx" ON "hospital_services"("category");

-- CreateIndex
CREATE INDEX "hospital_services_status_idx" ON "hospital_services"("status");
