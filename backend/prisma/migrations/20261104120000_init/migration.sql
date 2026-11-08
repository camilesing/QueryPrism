-- pgvector powers VectorService. Tables live in a dedicated schema that Prisma
-- Migrate does not manage (default: public only), so runtime-created vec_*
-- tables never register as migration drift.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS "vector_store";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Datasource" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "configuration" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "tableRelation" JSONB,
    "embedding" JSONB,
    "recommendedConfig" JSONB,
    "num" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Datasource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Table" (
    "id" SERIAL NOT NULL,
    "datasourceId" INTEGER NOT NULL,
    "tableName" TEXT NOT NULL,
    "tableComment" TEXT,
    "customComment" TEXT,
    "checked" BOOLEAN NOT NULL DEFAULT true,
    "embedding" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Field" (
    "id" SERIAL NOT NULL,
    "tableId" INTEGER NOT NULL,
    "fieldName" TEXT NOT NULL,
    "fieldType" TEXT,
    "fieldComment" TEXT,
    "customComment" TEXT,
    "isPrimaryKey" BOOLEAN NOT NULL DEFAULT false,
    "fieldIndex" INTEGER,
    "checked" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DsRecommendedProblem" (
    "id" SERIAL NOT NULL,
    "datasourceId" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DsRecommendedProblem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "datasourceId" INTEGER,
    "engineType" TEXT,
    "title" TEXT NOT NULL DEFAULT '新对话',
    "brief" TEXT,
    "origin" INTEGER NOT NULL DEFAULT 0,
    "recommendedQuestion" JSONB,
    "chatType" TEXT,
    "dsType" TEXT,
    "recommendedGenerate" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatRecord" (
    "id" SERIAL NOT NULL,
    "chatId" INTEGER NOT NULL,
    "oid" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "sqlAnswer" TEXT,
    "sql" TEXT,
    "sqlExecResult" JSONB,
    "data" JSONB,
    "chartAnswer" TEXT,
    "chart" JSONB,
    "chartType" TEXT,
    "brief" TEXT,
    "extractedKeywords" TEXT,
    "expandedKeywords" TEXT,
    "analysis" TEXT,
    "predict" TEXT,
    "predictData" JSONB,
    "recommendedQuestion" JSONB,
    "analysisRecordId" INTEGER,
    "predictRecordId" INTEGER,
    "regenerateRecordId" INTEGER,
    "finish" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "analysisThinking" TEXT,
    "predictContent" TEXT,
    "runTime" INTEGER NOT NULL DEFAULT 0,
    "firstChat" BOOLEAN NOT NULL DEFAULT false,
    "duration" INTEGER,
    "totalTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatLog" (
    "id" SERIAL NOT NULL,
    "chatRecordId" INTEGER NOT NULL,
    "messages" JSONB,
    "reasoningContent" TEXT,
    "tokenUsage" JSONB,
    "operate" TEXT,
    "localOperation" BOOLEAN NOT NULL DEFAULT false,
    "error" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ChatLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "account" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "oid" INTEGER NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 1,
    "origin" INTEGER NOT NULL DEFAULT 0,
    "language" TEXT NOT NULL DEFAULT 'zh-CN',
    "systemVariables" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserWs" (
    "id" SERIAL NOT NULL,
    "uid" INTEGER NOT NULL,
    "oid" INTEGER NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserWs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" SERIAL NOT NULL,
    "accessKey" TEXT NOT NULL,
    "secretKey" TEXT NOT NULL,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "uid" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" SERIAL NOT NULL,
    "module" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'success',
    "operatorId" INTEGER,
    "operator" TEXT,
    "detail" TEXT,
    "oid" INTEGER,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "executionTime" INTEGER,
    "errorMessage" TEXT,
    "requestMethod" TEXT,
    "requestPath" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLogsResource" (
    "id" SERIAL NOT NULL,
    "logId" INTEGER NOT NULL,
    "name" TEXT,
    "originId" TEXT,
    "originStr" TEXT,

    CONSTRAINT "SystemLogsResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemVariable" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "varType" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createTime" TIMESTAMP(3),
    "createBy" INTEGER,

    CONSTRAINT "SystemVariable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModel" (
    "id" SERIAL NOT NULL,
    "supplier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modelType" TEXT NOT NULL,
    "baseModel" TEXT,
    "defaultModel" BOOLEAN NOT NULL DEFAULT false,
    "apiKey" TEXT,
    "apiDomain" TEXT,
    "protocol" TEXT NOT NULL DEFAULT 'openai',
    "config" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelWorkspaceMapping" (
    "id" SERIAL NOT NULL,
    "modelId" INTEGER NOT NULL,
    "oid" INTEGER NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiModelWorkspaceMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Terminology" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "pid" INTEGER,
    "word" TEXT NOT NULL,
    "description" TEXT,
    "embedding" JSONB,
    "specificDs" BOOLEAN NOT NULL DEFAULT false,
    "datasourceIds" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "advancedApplication" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Terminology_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataTraining" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "datasource" INTEGER,
    "question" TEXT NOT NULL,
    "description" TEXT,
    "embedding" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "advancedApplication" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataTraining_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoreDashboard" (
    "id" SERIAL NOT NULL,
    "pid" INTEGER,
    "oid" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "nodeType" TEXT NOT NULL DEFAULT 'panel',
    "type" TEXT,
    "canvasStyleData" JSONB,
    "componentData" JSONB,
    "canvasViewInfo" JSONB,
    "mobileLayout" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentId" INTEGER,
    "createBy" INTEGER,
    "updateBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoreDashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assistant" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" INTEGER NOT NULL,
    "description" TEXT,
    "domain" TEXT,
    "configuration" JSONB,
    "appId" TEXT NOT NULL,
    "appSecret" TEXT NOT NULL,
    "enableCustomModel" BOOLEAN NOT NULL DEFAULT false,
    "customModel" JSONB,
    "picture" TEXT,
    "ui" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assistant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomPrompt" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "prompt" TEXT,
    "specificDs" BOOLEAN NOT NULL DEFAULT false,
    "datasourceIds" JSONB,
    "advancedApplication" TEXT,
    "createTime" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DsRules" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "userList" JSONB,
    "createTime" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DsRules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DsPermission" (
    "id" SERIAL NOT NULL,
    "rulesId" INTEGER NOT NULL,
    "name" TEXT,
    "type" TEXT NOT NULL,
    "dsId" INTEGER,
    "dsName" TEXT,
    "tableId" INTEGER,
    "tableName" TEXT,
    "expressionTree" TEXT,
    "permissions" TEXT,
    "createTime" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DsPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Table_datasourceId_idx" ON "Table"("datasourceId");

-- CreateIndex
CREATE INDEX "Field_tableId_idx" ON "Field"("tableId");

-- CreateIndex
CREATE INDEX "Chat_oid_idx" ON "Chat"("oid");

-- CreateIndex
CREATE INDEX "Chat_oid_updatedAt_idx" ON "Chat"("oid", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatRecord_chatId_idx" ON "ChatRecord"("chatId");

-- CreateIndex
CREATE INDEX "ChatRecord_oid_idx" ON "ChatRecord"("oid");

-- CreateIndex
CREATE INDEX "ChatRecord_chatId_createdAt_idx" ON "ChatRecord"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatLog_chatRecordId_idx" ON "ChatLog"("chatRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "User_account_key" ON "User"("account");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_name_key" ON "Workspace"("name");

-- CreateIndex
CREATE UNIQUE INDEX "UserWs_uid_oid_key" ON "UserWs"("uid", "oid");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_accessKey_key" ON "ApiKey"("accessKey");

-- CreateIndex
CREATE UNIQUE INDEX "SystemVariable_name_key" ON "SystemVariable"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AiModel_name_key" ON "AiModel"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AiModelWorkspaceMapping_modelId_oid_key" ON "AiModelWorkspaceMapping"("modelId", "oid");

-- CreateIndex
CREATE INDEX "Terminology_oid_idx" ON "Terminology"("oid");

-- CreateIndex
CREATE INDEX "Terminology_word_idx" ON "Terminology"("word");

-- CreateIndex
CREATE UNIQUE INDEX "Terminology_oid_word_key" ON "Terminology"("oid", "word");

-- CreateIndex
CREATE INDEX "DataTraining_oid_idx" ON "DataTraining"("oid");

-- CreateIndex
CREATE INDEX "DataTraining_datasource_idx" ON "DataTraining"("datasource");

-- CreateIndex
CREATE INDEX "DataTraining_oid_datasource_idx" ON "DataTraining"("oid", "datasource");

-- CreateIndex
CREATE INDEX "CoreDashboard_oid_idx" ON "CoreDashboard"("oid");

-- CreateIndex
CREATE INDEX "CoreDashboard_oid_pid_idx" ON "CoreDashboard"("oid", "pid");

-- CreateIndex
CREATE INDEX "CoreDashboard_oid_createBy_idx" ON "CoreDashboard"("oid", "createBy");

-- CreateIndex
CREATE UNIQUE INDEX "Assistant_appId_key" ON "Assistant"("appId");

-- CreateIndex
CREATE INDEX "Assistant_oid_idx" ON "Assistant"("oid");

-- CreateIndex
CREATE INDEX "CustomPrompt_oid_idx" ON "CustomPrompt"("oid");

-- CreateIndex
CREATE INDEX "CustomPrompt_type_idx" ON "CustomPrompt"("type");

-- CreateIndex
CREATE UNIQUE INDEX "CustomPrompt_oid_type_name_key" ON "CustomPrompt"("oid", "type", "name");

-- CreateIndex
CREATE INDEX "DsRules_oid_idx" ON "DsRules"("oid");

-- CreateIndex
CREATE INDEX "DsPermission_rulesId_idx" ON "DsPermission"("rulesId");

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_datasourceId_fkey" FOREIGN KEY ("datasourceId") REFERENCES "Datasource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Field" ADD CONSTRAINT "Field_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DsRecommendedProblem" ADD CONSTRAINT "DsRecommendedProblem_datasourceId_fkey" FOREIGN KEY ("datasourceId") REFERENCES "Datasource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_datasourceId_fkey" FOREIGN KEY ("datasourceId") REFERENCES "Datasource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatRecord" ADD CONSTRAINT "ChatRecord_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatLog" ADD CONSTRAINT "ChatLog_chatRecordId_fkey" FOREIGN KEY ("chatRecordId") REFERENCES "ChatRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserWs" ADD CONSTRAINT "UserWs_uid_fkey" FOREIGN KEY ("uid") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserWs" ADD CONSTRAINT "UserWs_oid_fkey" FOREIGN KEY ("oid") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemLog" ADD CONSTRAINT "SystemLog_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemLogsResource" ADD CONSTRAINT "SystemLogsResource_logId_fkey" FOREIGN KEY ("logId") REFERENCES "SystemLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiModelWorkspaceMapping" ADD CONSTRAINT "AiModelWorkspaceMapping_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AiModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiModelWorkspaceMapping" ADD CONSTRAINT "AiModelWorkspaceMapping_oid_fkey" FOREIGN KEY ("oid") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DsPermission" ADD CONSTRAINT "DsPermission_rulesId_fkey" FOREIGN KEY ("rulesId") REFERENCES "DsRules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

