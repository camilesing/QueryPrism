-- CreateTable
CREATE TABLE "RegressionCase" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "datasourceId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "metricCode" TEXT,
    "tolerancePct" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "baseline" JSONB,
    "createBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegressionCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegressionRun" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggerDetail" JSONB,
    "status" TEXT NOT NULL,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "flagged" INTEGER NOT NULL DEFAULT 0,
    "errored" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RegressionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegressionRunCase" (
    "id" SERIAL NOT NULL,
    "runId" INTEGER NOT NULL,
    "caseId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "sql" TEXT,
    "rowCount" INTEGER,
    "sums" JSONB,
    "delta" JSONB,
    "message" TEXT,
    "recordId" INTEGER,

    CONSTRAINT "RegressionRunCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryBudget" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" INTEGER,
    "dailyLimit" INTEGER NOT NULL,
    "createBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueryBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryUsageDaily" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "day" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "queries" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueryUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryCacheEntry" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "datasourceId" INTEGER NOT NULL,
    "sqlHash" TEXT NOT NULL,
    "sql" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueryCacheEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegressionCase_oid_datasourceId_idx" ON "RegressionCase"("oid", "datasourceId");

-- CreateIndex
CREATE INDEX "RegressionRun_oid_startedAt_idx" ON "RegressionRun"("oid", "startedAt");

-- CreateIndex
CREATE INDEX "RegressionRunCase_runId_idx" ON "RegressionRunCase"("runId");

-- CreateIndex
CREATE INDEX "RegressionRunCase_caseId_idx" ON "RegressionRunCase"("caseId");

-- CreateIndex
CREATE INDEX "QueryBudget_oid_idx" ON "QueryBudget"("oid");

-- CreateIndex
CREATE UNIQUE INDEX "QueryBudget_oid_subjectType_subjectId_key" ON "QueryBudget"("oid", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "QueryUsageDaily_oid_subjectType_subjectId_idx" ON "QueryUsageDaily"("oid", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "QueryUsageDaily_oid_day_subjectType_subjectId_key" ON "QueryUsageDaily"("oid", "day", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "QueryCacheEntry_oid_expiresAt_idx" ON "QueryCacheEntry"("oid", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "QueryCacheEntry_oid_datasourceId_sqlHash_key" ON "QueryCacheEntry"("oid", "datasourceId", "sqlHash");

-- AddForeignKey
ALTER TABLE "RegressionRunCase" ADD CONSTRAINT "RegressionRunCase_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RegressionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegressionRunCase" ADD CONSTRAINT "RegressionRunCase_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RegressionCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

