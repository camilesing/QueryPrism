-- Workspace isolation: datasources belong to a workspace, and workspaces
-- support soft delete (archive) before permanent removal.

-- Datasource: existing rows are backfilled to the default workspace (1) by
-- the column default.
ALTER TABLE "Datasource" ADD COLUMN "oid" INTEGER NOT NULL DEFAULT 1;

-- Workspace: NULL = active; non-NULL = archived (hidden from non-admins).
ALTER TABLE "Workspace" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Datasource_oid_idx" ON "Datasource"("oid");
CREATE INDEX "Workspace_archivedAt_idx" ON "Workspace"("archivedAt");