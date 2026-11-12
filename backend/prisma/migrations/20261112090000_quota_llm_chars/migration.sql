-- M7 quota unit change: daily query COUNT -> LLM interaction CHARACTERS.
--
-- The old numeric limits (e.g. 100 questions/day) are not comparable to a
-- character budget, so both budget and usage rows are cleared. After this
-- migration every workspace is unlimited until an admin configures a new
-- character budget at /system/setting/quota.
DELETE FROM "QueryUsageDaily";
DELETE FROM "QueryBudget";

-- The counter now stores characters instead of accepted questions.
ALTER TABLE "QueryUsageDaily" RENAME COLUMN "queries" TO "llmChars";