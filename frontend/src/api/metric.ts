import { request } from '@/utils/request'

/** MetaDataImprove M4 — metric system (atomic/modifier/period/derived/
 *  composite) + data standards (unit/naming) admin API (snake_case wire). */
export type MetricKind = 'atomic' | 'modifier' | 'period' | 'derived' | 'composite'
export type StandardKind = 'unit' | 'naming'
export type SemanticScope = 'GLOBAL' | 'WORKSPACE' | 'PERSONAL'

export interface MetricRow {
  id: number
  scope: SemanticScope
  oid: number | null
  owner_uid: number | null
  kind: MetricKind
  code: string
  name: string
  aliases: string[] | null
  description: string | null
  unit: string | null
  definition: Record<string, unknown>
  enabled: boolean
  version: number
  create_by: number | null
  create_time: string
  update_time: string
  table_exists: boolean
}

export interface StandardRow {
  id: number
  scope: SemanticScope
  oid: number | null
  owner_uid: number | null
  kind: StandardKind
  code: string
  term: string
  name: string
  aliases: string[] | null
  category: string | null
  description: string | null
  enabled: boolean
  version: number
  create_by: number | null
  create_time: string
  update_time: string
}

export interface DictPage<T> {
  current_page: number
  page_size: number
  total_count: number
  total_pages: number
  data: T[]
}

export interface ChangeRequestRow {
  id: number
  entity_type: string
  action: 'upsert' | 'remove'
  target_type: SemanticScope
  payload: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected'
  proposer_uid: number
  proposer: string | null
  reviewer_uid: number | null
  review_note: string | null
  reviewed_at: string | null
  create_time: string
}

export interface VersionRow {
  id: number
  version: number
  snapshot: Record<string, unknown>
  changed_by: number | null
  note: string | null
  create_time: string
}

export const metricApi = {
  page: (
    kind: MetricKind,
    currentPage: number,
    pageSize: number,
    params?: { scope?: string; datasource_id?: number; keyword?: string }
  ) =>
    request.get<DictPage<MetricRow>>(`/system/metric/page/${kind}/${currentPage}/${pageSize}`, {
      params,
    }),
  versions: (id: number) => request.get<VersionRow[]>(`/system/metric/versions/${id}`),
  /** Shared M4 approval inbox (metric + standard proposals). */
  requests: (box: 'pending' | 'mine', currentPage: number, pageSize: number) =>
    request.get<DictPage<ChangeRequestRow>>(
      `/system/metric/requests/${box}/${currentPage}/${pageSize}`
    ),
  /** Returns {applied:true,id} or {applied:false,request_id} (proposal). */
  upsert: (data: Record<string, unknown>) =>
    request.put<{ applied: boolean; id?: number; request_id?: number }>('/system/metric', data),
  review: (data: { id: number; approve: boolean; review_note?: string }) =>
    request.put('/system/metric/request/review', data),
  remove: (ids: number[]) => request.delete('/system/metric', { data: ids }),
  setEnabled: (id: number, enabled: boolean) =>
    request.get(`/system/metric/${id}/enable/${enabled}`),
}

export const standardApi = {
  page: (
    kind: StandardKind,
    currentPage: number,
    pageSize: number,
    params?: { scope?: string; category?: string; keyword?: string }
  ) =>
    request.get<DictPage<StandardRow>>(`/system/standard/page/${kind}/${currentPage}/${pageSize}`, {
      params,
    }),
  versions: (id: number) => request.get<VersionRow[]>(`/system/standard/versions/${id}`),
  upsert: (data: Record<string, unknown>) =>
    request.put<{ applied: boolean; id?: number; request_id?: number }>('/system/standard', data),
  remove: (ids: number[]) => request.delete('/system/standard', { data: ids }),
  setEnabled: (id: number, enabled: boolean) =>
    request.get(`/system/standard/${id}/enable/${enabled}`),
}
