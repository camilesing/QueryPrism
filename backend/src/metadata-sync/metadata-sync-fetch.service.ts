// Pulls one metadata batch from an external HTTP API or MCP server
// (MetaDataImprove M5). The returned rows must use the same shape as the
// /meta/* push endpoints; dispatch/validation stays in the import services.
// Auth is decrypted here and never logged.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MetadataSyncSource } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decryptJson } from '../common/utils/aes';
import { tr } from '../common/i18n/translate';
import {
  SYNC_TIMEOUT_MS,
  authHeaders,
  extractSyncRows,
  type SyncAuth,
} from './metadata-sync-policy';

@Injectable()
export class MetadataSyncFetchService {
  constructor(private readonly config: ConfigService) {}

  /** Fetch and structurally unwrap one batch (array or {data|rows:[...]}). */
  async fetchRows(source: MetadataSyncSource): Promise<unknown[]> {
    const auth = this.decryptAuth(source.authJson);
    const payload =
      source.kind === 'MCP'
        ? await this.fetchMcp(source, auth)
        : await this.fetchHttp(source, auth);
    const rows = extractSyncRows(payload);
    if (!rows) throw new Error(tr('metadata-sync.invalid_payload'));
    return rows;
  }

  private async fetchHttp(
    source: MetadataSyncSource,
    auth: SyncAuth | null,
  ): Promise<unknown> {
    const method = source.httpMethod === 'POST' ? 'POST' : 'GET';
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...authHeaders(auth),
    };
    let body: string | undefined;
    if (method === 'POST') {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
      body = JSON.stringify(source.httpBody ?? {});
    }
    const res = await fetch(source.endpoint, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    }).catch((e: unknown) => {
      // AbortSignal.timeout rejects with a DOMException named TimeoutError —
      // surface the localized message instead of the runtime wording.
      if ((e as { name?: string }).name === 'TimeoutError') {
        throw new Error(tr('metadata-sync.timeout'));
      }
      throw e;
    });
    if (!res.ok) {
      throw new Error(tr('metadata-sync.http_status', { status: res.status }));
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new Error(tr('metadata-sync.invalid_payload'));
    }
  }

  private async fetchMcp(
    source: MetadataSyncSource,
    auth: SyncAuth | null,
  ): Promise<unknown> {
    const tool = source.mcpTool?.trim();
    if (!tool) throw new Error(tr('metadata-sync.missing_tool'));
    const transport = new StreamableHTTPClientTransport(
      new URL(source.endpoint),
      { requestInit: { headers: authHeaders(auth) } },
    );
    const client = new Client({
      name: 'queryprism-metadata-sync',
      version: '1.0.0',
    });
    try {
      await this.withTimeout(client.connect(transport));
      const result = await this.withTimeout(
        client.callTool({
          name: tool,
          arguments: (source.mcpArgs as Record<string, unknown> | null) ?? {},
        }),
      );
      const content = result.content as
        | Array<{ type?: string; text?: string }>
        | undefined;
      const text = content?.find(
        (c) => c.type === 'text' && typeof c.text === 'string',
      )?.text;
      if (!text) throw new Error(tr('metadata-sync.mcp_empty'));
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(tr('metadata-sync.invalid_payload'));
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private decryptAuth(authJson: string | null): SyncAuth | null {
    if (!authJson) return null;
    const key = this.config.get<string>('aes.key');
    if (!key) throw new Error(tr('metadata-sync.auth_invalid'));
    try {
      return decryptJson<SyncAuth>(authJson, key);
    } catch {
      throw new Error(tr('metadata-sync.auth_invalid'));
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(tr('metadata-sync.timeout'))),
            SYNC_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
