-- AlterTable
-- ChatRecord clarify round (MetaDataImprove M1 rule 1): pause + ask the user
-- to narrow candidate tables before stuffing the schema.
ALTER TABLE "ChatRecord" ADD COLUMN     "clarify" JSONB,
ADD COLUMN     "clarifyAnswer" JSONB,
ADD COLUMN     "clarifyStatus" TEXT;
