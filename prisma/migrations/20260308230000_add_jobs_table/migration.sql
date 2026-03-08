-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "department" TEXT NOT NULL,
    "specialization" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "scheduleType" TEXT NOT NULL,
    "shiftPattern" TEXT NOT NULL,
    "experienceLevel" TEXT NOT NULL,
    "responsibilities" TEXT NOT NULL,
    "qualifications" TEXT NOT NULL,
    "requirements" TEXT NOT NULL,
    "benefits" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "applicationDeadline" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "requiredMedics" INTEGER NOT NULL DEFAULT 0,
    "hours" INTEGER NOT NULL DEFAULT 0,
    "payType" TEXT,
    "payAmount" DECIMAL(65,30) DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT NOT NULL,
    "employerType" TEXT NOT NULL,
    "employerName" TEXT NOT NULL,
    "applications" JSONB,
    "cancellationReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_createdBy_idx" ON "jobs"("createdBy");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_employerName_idx" ON "jobs"("employerName");

-- CreateIndex
CREATE INDEX "jobs_specialization_idx" ON "jobs"("specialization");

-- CreateIndex
CREATE INDEX "jobs_department_idx" ON "jobs"("department");

-- CreateIndex
CREATE INDEX "jobs_createdAt_idx" ON "jobs"("createdAt");
