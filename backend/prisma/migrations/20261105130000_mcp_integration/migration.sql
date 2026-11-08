-- MCP integration: workspace-scoped MCP service credentials. Each row is a
-- named integration (e.g. one per external Agent) with its own token.

-- CreateTable
CREATE TABLE "McpIntegration" (
    "id" SERIAL NOT NULL,
    "oid" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "accessKey" TEXT NOT NULL,
    "secretKey" TEXT NOT NULL,
    "createdBy" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpIntegration_accessKey_key" ON "McpIntegration"("accessKey");

-- CreateIndex
CREATE INDEX "McpIntegration_oid_idx" ON "McpIntegration"("oid");