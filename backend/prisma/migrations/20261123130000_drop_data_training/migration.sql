-- Remove the SQL sample library (data-training) feature. The table and its
-- derived vector index are dropped; the runtime no longer reads either. Export
-- any rows you need to keep BEFORE applying this migration.

DROP TABLE IF EXISTS "DataTraining";

-- Remove the persisted tuning rows for the retired feature. `embedding.enabled`
-- only gated data-training generation/recall, so it is dead after this change;
-- table recall and metric recall keep their own switches.
DELETE FROM "SystemVariable"
 WHERE "type" = 'parameter'
   AND "name" IN (
     'embedding.enabled',
     'embedding.data_training_similarity',
     'embedding.data_training_top_count'
   );

-- vector_store is unmanaged; guard the drop so fresh databases (where the
-- collection was never created) migrate cleanly.
DO $$
BEGIN
  IF to_regclass('vector_store.vec_data_training') IS NOT NULL THEN
    DROP TABLE vector_store.vec_data_training;
  END IF;
END $$;