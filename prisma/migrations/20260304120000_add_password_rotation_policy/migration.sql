-- Add password rotation policy fields to users
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "passwordUpdateIntervalDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "passwordExpiresAt" TIMESTAMP(3);

UPDATE "users"
SET "passwordChangedAt" = COALESCE("passwordChangedAt", CURRENT_TIMESTAMP)
WHERE "passwordChangedAt" IS NULL;
