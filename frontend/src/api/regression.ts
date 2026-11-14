import { request } from '@/utils/request'

/** MetaDataImprove M6 — semantic regression suite admin API. Request bodies
 *  and query params are snake_case (Nest DTOs); list/detail responses are raw
 *  Prisma rows (camelCase) — the interfaces below mirror those. */
export interface RegressionCaseRow {
  id: number
  oid: number
  datasourceId: number
  name: string
  question: string
  metricCode: string | null
  tolerancePct: number
  enabled: boolean
  baseline: {
    rowCount: number
    sums: Record<string, number>
    sqlHash: string
    capturedAt: string
    runId: number
  } | null
  createBy: number | null
  createdAt: string
  updatedAt: string
}

export interface RegressionRunRow {
  id: number
  oid: number
  trigger: 'approval' | 'manual' | 'api'
  triggerDetail: Record<string, unknown> | null
  status: 'running' | 'done'
  passed: number
  flagged: number
  errored: number
  startedAt: string
  finishedAt: string | null
}

export interface RegressionRunCaseRow {
  id: number
  runId: number
  caseId: number
  status: 'passed' | 'flagged' | 'baseline_captured' | 'needs_clarify' | 'error'
  sql: string | null
  rowCount: number | null
  sums: Record<string, number> | null
  delta: {
    rowCountPct: number | null
    sums: Record<string, number>
    newColumns: string[]
    missingColumns: string[]
    /** Alias renames forgiven by the comparison (LLM alias drift); absent on
     *  rows written before that existed. */
    renamedColumns?: { from: string; to: string }[]
    reasons: string[]
  } | null
  message: string | null
  recordId: number | null
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
