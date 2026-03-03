-- AlterTable
ALTER TABLE "medical_records" ADD COLUMN     "attachments" JSONB;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "readAt" TIMESTAMP(3);
