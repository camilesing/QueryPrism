-- New users default to English (i18n: en + zh-CN).
ALTER TABLE "User" ALTER COLUMN "language" SET DEFAULT 'en';

-- Backfill: normalize stored languages outside the supported set (e.g. the
-- retired zh-TW / ko-KR locales) to English.
UPDATE "User" SET "language" = 'en' WHERE "language" NOT IN ('en', 'zh-CN');
