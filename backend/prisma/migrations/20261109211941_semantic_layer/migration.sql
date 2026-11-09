-- CreateTable
CREATE TABLE "TableSemantic" (
    "id" SERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "oid" INTEGER,
    "ownerUid" INTEGER,
    "datasourceId" INTEGER NOT NULL,
    "tableName" TEXT NOT NULL,
    "meaning" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TableSemantic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TableSemanticVersion" (
    "id" SERIAL NOT NULL,
    "entityId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableSemanticVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldSemantic" (
    "id" SERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "oid" INTEGER,
    "ownerUid" INTEGER,
    "datasourceId" INTEGER NOT NULL,
    "tableName" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "meaning" TEXT NOT NULL,
    "unit" TEXT,
    "enumValues" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldSemantic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldSemanticVersion" (
    "id" SERIAL NOT NULL,
    "entityId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FieldSemanticVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SemanticChangeRequest" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposerUid" INTEGER NOT NULL,
    "proposer" TEXT,
    "reviewerUid" INTEGER,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SemanticChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TableSemantic_datasourceId_tableName_idx" ON "TableSemantic"("datasourceId", "tableName");

-- CreateIndex
CREATE INDEX "TableSemantic_scope_datasourceId_tableName_idx" ON "TableSemantic"("scope", "datasourceId", "tableName");

-- CreateIndex
CREATE INDEX "TableSemantic_oid_ownerUid_idx" ON "TableSemantic"("oid", "ownerUid");

-- CreateIndex
CREATE UNIQUE INDEX "TableSemanticVersion_entityId_version_key" ON "TableSemanticVersion"("entityId", "version");

-- CreateIndex
CREATE INDEX "FieldSemantic_datasourceId_tableName_fieldName_idx" ON "FieldSemantic"("datasourceId", "tableName", "fieldName");

-- CreateIndex
CREATE INDEX "FieldSemantic_scope_datasourceId_tableName_fieldName_idx" ON "FieldSemantic"("scope", "datasourceId", "tableName", "fieldName");

-- CreateIndex
CREATE INDEX "FieldSemantic_oid_ownerUid_idx" ON "FieldSemantic"("oid", "ownerUid");

-- CreateIndex
CREATE UNIQUE INDEX "FieldSemanticVersion_entityId_version_key" ON "FieldSemanticVersion"("entityId", "version");

-- CreateIndex
CREATE INDEX "SemanticChangeRequest_oid_status_targetType_idx" ON "SemanticChangeRequest"("oid", "status", "targetType");

-- CreateIndex
CREATE INDEX "SemanticChangeRequest_proposerUid_status_idx" ON "SemanticChangeRequest"("proposerUid", "status");

-- AddForeignKey
ALTER TABLE "TableSemanticVersion" ADD CONSTRAINT "TableSemanticVersion_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "TableSemantic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldSemanticVersion" ADD CONSTRAINT "FieldSemanticVersion_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "FieldSemantic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

