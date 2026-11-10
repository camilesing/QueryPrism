// Pure policy for external metadata sync (MetaDataImprove M5): source
// validation + auth/payload helpers. No Nest/Prisma imports so the rules are
// unit-testable in isolation — the services own persistence and HTTP.

import { CronTime } from 'cron';

export const SYNC_KINDS = ['HTTP_API', 'MCP'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export const SYNC_TARGETS = ['semantic', 'metric', 'standard'] as const;
export type SyncTarget = (typeof SYNC_TARGETS)[number];

export const SYNC_HTTP_METHODS = ['GET', 'POST'] as const;
export type SyncHttpMethod = (typeof SYNC_HTTP_METHODS)[number];

/** Same batch ceiling as the /meta/* push endpoints. */
export const SYNC_MAX_ROWS = 5000;
/** Per-run failure detail cap (the run row keeps counts regardless). */
export const SYNC_MAX_FAILURES = 50;
/** One pull must finish within this window. */
export const SYNC_TIMEOUT_MS = 30_000;

export interface SyncAuth {
  /** Extra request headers, e.g. X-API-Key. */
  headers?: Record<string, string>;
  /** Convenience: sent as Authorization: Bearer <token>. */
  token?: string;
}

/** Only http(s) endpoints are allowed (admin-configured; no file/other). */
export function isValidEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validate a cron expression without scheduling it. */
export function isValidCron(expr: string): boolean {
  try {
    new CronTime(expr);
    return true;
  } catch {
    return false;
  }
}

export function isValidAuth(auth: unknown): boolean {
  if (auth == null) return true;
  if (typeof auth !== 'object' || Array.isArray(auth)) return false;
  const a = auth as { headers?: unknown; token?: unknown };
  if (a.token !== undefined && typeof a.token !== 'string') return false;
  if (a.headers !== undefined) {
    if (
      a.headers == null ||
      typeof a.headers !== 'object' ||
      Array.isArray(a.headers)
    ) {
      return false;
    }
    for (const [, value] of Object.entries(a.headers)) {
      if (typeof value !== 'string') return false;
    }
  }
  return true;
}

/** Merge the stored auth config into request headers. Never logged. */
export function authHeaders(
  auth: SyncAuth | null | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth?.headers) {
    for (const [key, value] of Object.entries(auth.headers)) {
      if (key.trim() && typeof value === 'string') headers[key] = value;
    }
  }
  const token = typeof auth?.token === 'string' ? auth.token.trim() : '';
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Accept the /meta-compatible top-level array, or a {data:[...]} / {rows:[...]}
 *  wrapper (both common pull API shapes). Returns null when neither matches. */
export function extractSyncRows(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload as unknown[];
  if (
    payload != null &&
    typeof payload === 'object' &&
    !Array.isArray(payload)
  ) {
    const obj = payload as { data?: unknown; rows?: unknown };
    if (Array.isArray(obj.data)) return obj.data as unknown[];
    if (Array.isArray(obj.rows)) return obj.rows as unknown[];
  }
  return null;
}

/** Keep a failure reason short enough for the audit/run log. */
export function syncErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.length > 1000 ? `${raw.slice(0, 997)}...` : raw;
}
