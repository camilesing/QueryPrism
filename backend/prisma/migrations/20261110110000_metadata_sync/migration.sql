-- MetaDataImprove M5: external metadata sync sources (HTTP API / MCP) + runs.

-- CreateTable
CREATE TABLE "MetadataSyncSource" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL DEFAULT 'GET',
    "httpBody" JSONB,
    "authJson" TEXT,
    "mcpTool" TEXT,
    "mcpArgs" JSONB,
    "cron" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" INTEGER NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetadataSyncSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetadataSyncRun" (
    "id" SERIAL NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "failed" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MetadataSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetadataSyncSource_oid_name_key" ON "MetadataSyncSource"("oid", "name");

-- CreateIndex
CREATE INDEX "MetadataSyncSource_oid_idx" ON "MetadataSyncSource"("oid");

-- CreateIndex
CREATE INDEX "MetadataSyncRun_sourceId_startedAt_idx" ON "MetadataSyncRun"("sourceId", "startedAt");

-- AddForeignKey
ALTER TABLE "MetadataSyncRun" ADD CONSTRAINT "MetadataSyncRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "MetadataSyncSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;