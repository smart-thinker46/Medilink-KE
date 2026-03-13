-- CreateTable
CREATE TABLE "hospital_services" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hospital_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hospital_services_tenantId_idx" ON "hospital_services"("tenantId");

-- CreateIndex
CREATE INDEX "hospital_services_name_idx" ON "hospital_services"("name");

-- AddForeignKey
ALTER TABLE "hospital_services" ADD CONSTRAINT "hospital_services_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
