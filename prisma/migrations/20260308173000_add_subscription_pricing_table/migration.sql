-- Persist subscription pricing in database (instead of in-memory defaults)
CREATE TABLE IF NOT EXISTS "subscription_pricing" (
  "id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "monthly" INTEGER NOT NULL DEFAULT 0,
  "yearly" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "subscription_pricing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscription_pricing_role_key"
  ON "subscription_pricing"("role");
