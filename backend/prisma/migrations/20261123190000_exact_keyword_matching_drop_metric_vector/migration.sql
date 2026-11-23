-- Metric definitions, naming rules and semantic prompt annotations are now
-- matched by EXACT keyword equality only (the LLM-extracted business nouns).
-- The metric vector-similarity path has no reader left, so its derived column,
-- its pgvector table and the retired tuning rows are dropped.
--
-- MetricDef.embedding was a derived, rebuildable cache (name + aliases +
-- description) — nothing to export. Run this with every app instance stopped:
-- an older instance would still write the column.

-- DropColumn
ALTER TABLE "MetricDef" DROP COLUMN IF EXISTS "embedding";

-- Remove the persisted tuning rows that no longer exist in the registry.
-- Keyword extraction always runs; the recall width is the constant
-- TABLE_RECALL_TOP_K; metric matching has no vector stage any more.
-- semantic.max_tables keeps its saved value on purpose — only the code
-- default moved (1 -> 3); an admin who saved the page still holds their value.
DELETE FROM "SystemVariable"
 WHERE "type" = 'parameter'
   AND "name" IN (
     'embedding.keyword_enabled',
     'embedding.table_count',
     'metric.similarity_threshold'
   );

-- vector_store is unmanaged; guard the drop so fresh databases (where the
-- collection was never created) migrate cleanly.
DO $$
BEGIN
  IF to_regclass('vector_store.vec_metric_def') IS NOT NULL THEN
    DROP TABLE vector_store.vec_metric_def;
  END IF;
END $$;
