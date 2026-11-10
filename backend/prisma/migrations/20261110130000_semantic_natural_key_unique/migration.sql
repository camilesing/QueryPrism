-- MetaDataImprove: DB-level natural-key uniqueness for the governed semantic /
-- metric / standard dictionaries. Until now the service-layer findFirst+create
-- inside a Read Committed transaction was the only guard, so two concurrent
-- upserts could insert duplicate rows for the same scope-layer natural key.
--
-- Partial unique indexes cannot be expressed in the Prisma schema (PSL has no
-- WHERE clause), so they live only in this migration. Prisma does not manage
-- them; after changing the schema run `prisma migrate diff` to confirm it does
-- not try to drop them.
--
-- Existing duplicates are race artefacts: keep the newest row (runtime
-- resolution already prefers updatedAt) and delete the rest. Version history
-- rows cascade with the deleted duplicates.

-- ---- TableSemantic: (datasourceId, tableName) per scope layer ----------------
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY scope, oid, "ownerUid", "datasourceId", "tableName"
      ORDER BY "updatedAt" DESC, version DESC, id DESC
    ) AS rn
  FROM "TableSemantic"
)
DELETE FROM "TableSemantic"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "TableSemantic_global_natural_key"
  ON "TableSemantic" ("datasourceId", "tableName")
  WHERE scope = 'GLOBAL';

CREATE UNIQUE INDEX "TableSemantic_workspace_natural_key"
  ON "TableSemantic" ("oid", "datasourceId", "tableName")
  WHERE scope = 'WORKSPACE';

CREATE UNIQUE INDEX "TableSemantic_personal_natural_key"
  ON "TableSemantic" ("oid", "ownerUid", "datasourceId", "tableName")
  WHERE scope = 'PERSONAL';

-- ---- FieldSemantic: (datasourceId, tableName, fieldName) per scope layer ----
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY scope, oid, "ownerUid", "datasourceId", "tableName", "fieldName"
      ORDER BY "updatedAt" DESC, version DESC, id DESC
    ) AS rn
  FROM "FieldSemantic"
)
DELETE FROM "FieldSemantic"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "FieldSemantic_global_natural_key"
  ON "FieldSemantic" ("datasourceId", "tableName", "fieldName")
  WHERE scope = 'GLOBAL';

CREATE UNIQUE INDEX "FieldSemantic_workspace_natural_key"
  ON "FieldSemantic" ("oid", "datasourceId", "tableName", "fieldName")
  WHERE scope = 'WORKSPACE';

CREATE UNIQUE INDEX "FieldSemantic_personal_natural_key"
  ON "FieldSemantic" ("oid", "ownerUid", "datasourceId", "tableName", "fieldName")
  WHERE scope = 'PERSONAL';

-- ---- MetricDef: (kind, code) per scope layer --------------------------------
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY scope, oid, "ownerUid", kind, code
      ORDER BY "updatedAt" DESC, version DESC, id DESC
    ) AS rn
  FROM "MetricDef"
)
DELETE FROM "MetricDef"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "MetricDef_global_natural_key"
  ON "MetricDef" (kind, code)
  WHERE scope = 'GLOBAL';

CREATE UNIQUE INDEX "MetricDef_workspace_natural_key"
  ON "MetricDef" (oid, kind, code)
  WHERE scope = 'WORKSPACE';

CREATE UNIQUE INDEX "MetricDef_personal_natural_key"
  ON "MetricDef" (oid, "ownerUid", kind, code)
  WHERE scope = 'PERSONAL';

-- ---- DataStandard: (kind, code) per scope layer -----------------------------
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY scope, oid, "ownerUid", kind, code
      ORDER BY "updatedAt" DESC, version DESC, id DESC
    ) AS rn
  FROM "DataStandard"
)
DELETE FROM "DataStandard"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "DataStandard_global_natural_key"
  ON "DataStandard" (kind, code)
  WHERE scope = 'GLOBAL';

CREATE UNIQUE INDEX "DataStandard_workspace_natural_key"
  ON "DataStandard" (oid, kind, code)
  WHERE scope = 'WORKSPACE';

CREATE UNIQUE INDEX "DataStandard_personal_natural_key"
  ON "DataStandard" (oid, "ownerUid", kind, code)
  WHERE scope = 'PERSONAL';