import { request } from '@/utils/request'

export type SyncKind = 'HTTP_API' | 'MCP'
export type SyncTarget = 'semantic' | 'metric' | 'standard'
export type SyncHttpMethod = 'GET' | 'POST'

export interface MetadataSyncSource {
  id: number
  name: string
  kind: SyncKind
  target: SyncTarget
  endpoint: string
  http_method: SyncHttpMethod
  http_body: unknown
  mcp_tool: string | null
  mcp_args: Record<string, unknown> | null
  cron: string | null
  enabled: boolean
  created_by: number
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  has_auth: boolean
  create_time: string
  update_time: string
}

export interface MetadataSyncRun {
  id: number
  source_id: number
  trigger: 'manual' | 'cron'
  status: 'success' | 'failed'
  applied: number
  failed_count: number
  failed: Array<{ row: string; reason: string }> | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export interface MetadataSyncAuth {
  headers?: Record<string, string>
  token?: string
}

export interface MetadataSyncUpsert {
  id?: number
  name: string
  kind: SyncKind
  target: SyncTarget
  endpoint: string
  http_method?: SyncHttpMethod
  http_body?: unknown
  /** undefined keeps the stored secret, null clears it. */
  auth?: MetadataSyncAuth | null
  mcp_tool?: string | null
  mcp_args?: Record<string, unknown> | null
  cron?: string | null
  enabled?: boolean
}

export interface MetadataSyncRunPage {
  data: MetadataSyncRun[]
  total_count: number
}

export const metadataSyncApi = {
  list: (): Promise<MetadataSyncSource[]> => request.get('/system/metadata-sync'),
  create: (data: MetadataSyncUpsert): Promise<MetadataSyncSource> =>
    request.post('/system/metadata-sync', data),
  update: (data: MetadataSyncUpsert): Promise<MetadataSyncSource> =>
    request.put('/system/metadata-sync', data),
  remove: (id: number) => request.delete(`/system/metadata-sync/${id}`),
  run: (id: number) =>
    request.post(`/system/metadata-sync/${id}/run`) as Promise<{
      run_id: number
      status: 'success' | 'failed'
      applied: number
      failed_count: number
    }>,
  runs: (id: number, page = 1, size = 20): Promise<MetadataSyncRunPage> =>
    request.get(`/system/metadata-sync/${id}/runs/${page}/${size}`),
}
