import { request } from '@/utils/request'

/** MetaDataImprove M6 — semantic regression suite admin API (snake_case wire). */

export interface RegressionCaseRow {
  id: number
  oid: number
  datasource_id: number
  name: string
  question: string
  metric_code: string | null
  tolerance_pct: number
  enabled: boolean
  baseline: {
    rowCount: number
    sums: Record<string, number>
    sqlHash: string
    capturedAt: string
    runId: number
  } | null
  create_by: number | null
  create_time: string
  update_time: string
}

export interface RegressionRunRow {
  id: number
  oid: number
  trigger: 'approval' | 'manual' | 'api'
  trigger_detail: Record<string, unknown> | null
  status: 'running' | 'done'
  passed: number
  flagged: number
  errored: number
  started_at: string
  finished_at: string | null
}

export interface RegressionRunCaseRow {
  id: number
  run_id: number
  case_id: number
  status: 'passed' | 'flagged' | 'baseline_captured' | 'needs_clarify' | 'error'
  sql: string | null
  row_count: number | null
  sums: Record<string, number> | null
  delta: {
    rowCountPct: number | null
    sums: Record<string, number>
    newColumns: string[]
    missingColumns: string[]
    reasons: string[]
  } | null
  message: string | null
  record_id: number | null
  case?: { name: string; question: string }
}

export interface RegressionPage<T> {
  rows: T[]
  total: number
}

export const regressionApi = {
  cases: (params?: { datasource_id?: number; current_page?: number; page_size?: number }) =>
    request.get<RegressionPage<RegressionCaseRow>>('/system/regression', { params }),
  upsertCase: (data: {
    id?: number
    datasource_id: number
    name: string
    question: string
    metric_code?: string | null
    tolerance_pct?: number
    enabled?: boolean
  }) => request.put<{ id: number }>('/system/regression', data),
  removeCase: (id: number) => request.delete(`/system/regression/${id}`),
  setCaseEnabled: (id: number, enabled: boolean) =>
    request.post(`/system/regression/${id}/enable/${enabled}`),
  /** Start a manual run now; poll `runs` for the outcome. */
  run: () => request.post<number>('/system/regression/run'),
  runs: (params?: { current_page?: number; page_size?: number }) =>
    request.get<RegressionPage<RegressionRunRow>>('/system/regression/runs', { params }),
  runDetail: (id: number) =>
    request.get<{ run: RegressionRunRow; cases: RegressionRunCaseRow[] }>(
      `/system/regression/run/${id}`
    ),
  /** Adopt a finished run's aggregates as the new baselines. */
  promote: (id: number) =>
    request.post<{ promoted: number }>(`/system/regression/run/${id}/promote`),
}
