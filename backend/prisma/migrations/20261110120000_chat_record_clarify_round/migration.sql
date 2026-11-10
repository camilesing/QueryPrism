-- AlterTable
-- ChatRecord clarify round budget (MetaDataImprove M1): every pause increments
-- the counter so clarify.max_rounds > 1 can ask a bounded number of times.
ALTER TABLE "ChatRecord" ADD COLUMN     "clarifyRound" INTEGER NOT NULL DEFAULT 0;

-- Existing rows that already paused once (answered/skipped/pending) have
-- spent one round; without this backfill a max_rounds > 1 config would treat
-- historical records as never asked.
UPDATE "ChatRecord" SET "clarifyRound" = 1 WHERE "clarifyStatus" IS NOT NULL;