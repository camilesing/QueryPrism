// Snake_case wire mapping for the metadata-sync admin API. `authJson` is
// deliberately never serialized — only the boolean `has_auth` leaves the
// server (the secret is AES-encrypted at rest and write-only).

import type { MetadataSyncRun, MetadataSyncSource } from '@prisma/client';

export interface MetadataSyncSourceSnake {
  id: number;
  name: string;
  kind: string;
  target: string;
  endpoint: string;
  http_method: string;
  http_body: unknown;
  mcp_tool: string | null;
  mcp_args: unknown;
  cron: string | null;
  enabled: boolean;
  created_by: number;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  has_auth: boolean;
  create_time: Date;
  update_time: Date;
}

export function toMetadataSyncSourceSnake(
  row: MetadataSyncSource,
): MetadataSyncSourceSnake {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    target: row.target,
    endpoint: row.endpoint,
    http_method: row.httpMethod,
    http_body: row.httpBody,
    mcp_tool: row.mcpTool,
    mcp_args: row.mcpArgs,
    cron: row.cron,
    enabled: row.enabled,
    created_by: row.createdBy,
    last_run_at: row.lastRunAt,
    last_status: row.lastStatus,
    last_error: row.lastError,
    has_auth: !!row.authJson,
    create_time: row.createdAt,
    update_time: row.updatedAt,
  };
}

export interface MetadataSyncRunSnake {
  id: number;
  source_id: number;
  trigger: string;
  status: string;
  applied: number;
  failed_count: number;
  failed: unknown;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export function toMetadataSyncRunSnake(
  row: MetadataSyncRun,
): MetadataSyncRunSnake {
  return {
    id: row.id,
    source_id: row.sourceId,
    trigger: row.trigger,
    status: row.status,
    applied: row.applied,
    failed_count: row.failedCount,
    failed: row.failed,
    error: row.error,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
  };
}
