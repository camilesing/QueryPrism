-- MetaDataImprove M3 follow-up: version the user-edited relation graph.
-- The Datasource.tableRelation JSON stays the runtime source of truth (latest);
-- every save also appends a DatasourceRelationVersion snapshot for review.

-- AlterTable
ALTER TABLE "Datasource" ADD COLUMN "relationVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DatasourceRelationVersion" (
    "id" SERIAL NOT NULL,
    "datasourceId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasourceRelationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DatasourceRelationVersion_datasourceId_version_key" ON "DatasourceRelationVersion"("datasourceId", "version");

-- CreateIndex
CREATE INDEX "DatasourceRelationVersion_datasourceId_createdAt_idx" ON "DatasourceRelationVersion"("datasourceId", "createdAt");

-- AddForeignKey
ALTER TABLE "DatasourceRelationVersion" ADD CONSTRAINT "DatasourceRelationVersion_datasourceId_fkey" FOREIGN KEY ("datasourceId") REFERENCES "Datasource"("id") ON DELETE CASCADE ON UPDATE CASCADE;