-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "specifications" TEXT,
    "specialization" TEXT,
    "requiredMedics" INTEGER NOT NULL DEFAULT 0,
    "hours" INTEGER NOT NULL DEFAULT 0,
    "payType" TEXT,
    "payAmount" DECIMAL(65,30) DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT NOT NULL,
    "hospitalName" TEXT,
    "location" TEXT,
    "applications" JSONB,
    "cancellationReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shifts_createdBy_idx" ON "shifts"("createdBy");

-- CreateIndex
CREATE INDEX "shifts_status_idx" ON "shifts"("status");

-- CreateIndex
CREATE INDEX "shifts_hospitalName_idx" ON "shifts"("hospitalName");

-- CreateIndex
CREATE INDEX "shifts_specialization_idx" ON "shifts"("specialization");

-- CreateIndex
CREATE INDEX "shifts_createdAt_idx" ON "shifts"("createdAt");

