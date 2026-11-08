// Wire shape for the MCP-integration admin page. The full token is NEVER
// included in list responses — `token` is '' unless create/rotate/reveal
// explicitly supplies the plaintext (mirrors ApiKeyService's reveal-on-demand
// contract). `access_key` is the public lookup prefix and is safe to expose.
import type { McpIntegration } from '@prisma/client';

export interface McpIntegrationSnake {
  id: number;
  name: string;
  description: string | null;
  access_key: string;
  token: string;
  status: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toMcpIntegrationSnake(
  row: McpIntegration,
  opts?: { token?: string },
): McpIntegrationSnake {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    access_key: row.accessKey,
    token: opts?.token ?? '',
    status: row.status,
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
