-- MetaDataImprove M4: 指标体系字典（atomic/modifier/period/derived/composite，
-- 按 kind 判别 + definition JSONB 判别负载）与数据标准字典（unit/naming），
-- 各带 append-only 版本历史。治理复用 SemanticChangeRequest（entityType
-- 新增 'metric' | 'standard' 取值，String 列无 DDL 变更）。

-- CreateTable
CREATE TABLE "MetricDef" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" JSONB,
    "description" TEXT,
    "unit" TEXT,
    "definition" JSONB NOT NULL,
    "scope" TEXT NOT NULL,
    "oid" INTEGER,
    "ownerUid" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricDefVersion" (
    "id" SERIAL NOT NULL,
    "entityId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricDefVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataStandard" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" JSONB,
    "category" TEXT,
    "description" TEXT,
    "scope" TEXT NOT NULL,
    "oid" INTEGER,
    "ownerUid" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataStandard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataStandardVersion" (
    "id" SERIAL NOT NULL,
    "entityId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataStandardVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetricDef_kind_code_idx" ON "MetricDef"("kind", "code");

-- CreateIndex
CREATE INDEX "MetricDef_oid_ownerUid_idx" ON "MetricDef"("oid", "ownerUid");

-- CreateIndex
CREATE UNIQUE INDEX "MetricDefVersion_entityId_version_key" ON "MetricDefVersion"("entityId", "version");

-- CreateIndex
CREATE INDEX "DataStandard_kind_code_idx" ON "DataStandard"("kind", "code");

-- CreateIndex
CREATE INDEX "DataStandard_oid_ownerUid_idx" ON "DataStandard"("oid", "ownerUid");

-- CreateIndex
CREATE UNIQUE INDEX "DataStandardVersion_entityId_version_key" ON "DataStandardVersion"("entityId", "version");

-- AddForeignKey
ALTER TABLE "MetricDefVersion" ADD CONSTRAINT "MetricDefVersion_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "MetricDef"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataStandardVersion" ADD CONSTRAINT "DataStandardVersion_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "DataStandard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
