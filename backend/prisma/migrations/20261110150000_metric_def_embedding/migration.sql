-- MetaDataImprove M4 follow-up: metric vector recall.
-- MetricDef.embedding is the portable source of truth for the metric's vector;
-- the derived search index lives in vector_store."vec_metric_def" (unmanaged,
-- rebuildable via VectorService + the null-embedding backfill). Historical rows
-- start NULL — that is exactly the backfill's input (dictionary edits, imports
-- and approvals fill their own rows; startup / manual backfill covers the rest).

-- AlterTable
ALTER TABLE "MetricDef" ADD COLUMN     "embedding" JSONB;