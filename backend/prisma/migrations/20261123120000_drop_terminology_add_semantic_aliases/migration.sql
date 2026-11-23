-- Remove the legacy Terminology layer and move its synonym capability into the
-- governed semantic layer. TableSemantic/FieldSemantic.aliases feed the table
-- recall keyword expansion (replacing Terminology.expandWithTerminology); the
-- <terminologies> prompt block is gone — business meanings live in
-- `meaning` / metric definitions / naming rules.
--
-- Terminology rows are NOT migrated (product decision): the table is dropped.
-- Export at /set/professional before applying this migration if the data must
-- be kept.
ALTER TABLE "TableSemantic" ADD COLUMN "aliases" JSONB;
ALTER TABLE "FieldSemantic" ADD COLUMN "aliases" JSONB;

DROP TABLE IF EXISTS "Terminology";

-- Persisted retrieval tuning that only served the terminology recall.
DELETE FROM "SystemVariable"
 WHERE "name" IN (
   'embedding.terminology_similarity',
   'embedding.terminology_top_count'
 );

-- Derived pgvector table (unmanaged schema, created lazily by VectorService).
-- to_regclass is NULL when the schema/table was never created, so this is safe
-- on fresh installs and on the e2e database (vector_store is dropped first).
DO $$
BEGIN
  IF to_regclass('vector_store.vec_terminology') IS NOT NULL THEN
    DROP TABLE vector_store.vec_terminology;
  END IF;
END $$;