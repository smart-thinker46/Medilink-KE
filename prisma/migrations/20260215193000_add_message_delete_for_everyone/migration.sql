ALTER TABLE "messages"
ADD COLUMN "deletedForEveryone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "deletedAt" TIMESTAMP(3);
