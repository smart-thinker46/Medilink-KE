ALTER TABLE "messages"
ADD COLUMN "hiddenForSender" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "hiddenForRecipient" BOOLEAN NOT NULL DEFAULT false;
