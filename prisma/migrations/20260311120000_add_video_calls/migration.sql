-- CreateTable
CREATE TABLE "video_calls" (
    "id" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "participantId" TEXT,
    "callerRole" TEXT,
    "callType" TEXT,
    "appointmentId" TEXT,
    "paymentId" TEXT,
    "minutes" INTEGER,
    "mode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RINGING',
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "answeredBy" TEXT,
    "endedBy" TEXT,
    "videoEnabled" BOOLEAN,
    "audioEnabled" BOOLEAN,
    "facing" TEXT,
    "isOnHold" BOOLEAN,
    "holdUpdatedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_calls_callerId_createdAt_idx" ON "video_calls"("callerId", "createdAt");

-- CreateIndex
CREATE INDEX "video_calls_participantId_createdAt_idx" ON "video_calls"("participantId", "createdAt");

-- CreateIndex
CREATE INDEX "video_calls_status_createdAt_idx" ON "video_calls"("status", "createdAt");
