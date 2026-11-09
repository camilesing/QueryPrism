import { request } from '@/utils/request'

/** MetaDataImprove M2 — table/field semantics admin API (snake_case wire). */
export type SemanticEntityType = 'table' | 'field'
export type SemanticScope = 'GLOBAL' | 'WORKSPACE' | 'PERSONAL'

export interface SemanticRow {
  id: number
  scope: SemanticScope
  oid: number | null
  owner_uid: number | null
  datasource_id: number
  table_name: string
  field_name?: string
  role?: string
  meaning: string
  unit?: string | null
  enum_values?: Array<{ value: string; label?: string }> | null
  enabled: boolean
  version: number
  create_by: number | null
  create_time: string
  update_time: string
  table_exists: boolean
}

export interface SemanticPage<T> {
  current_page: number
  page_size: number
  total_count: number
  total_pages: number
  data: T[]
}

export interface SemanticChangeRequestRow {
  id: number
  entity_type: SemanticEntityType
  action: 'upsert' | 'remove'
  target_type: SemanticScope
  payload: {
    datasource_id?: number
    table_name?: string
    field_name?: string
    meaning?: string
    [key: string]: unknown
  }
  status: 'pending' | 'approved' | 'rejected'
  proposer_uid: number
  proposer: string | null
  reviewer_uid: number | null
  review_note: string | null
  reviewed_at: string | null
  create_time: string
}

export interface SemanticVersionRow {
  id: number
  version: number
  snapshot: { meaning?: string; enabled?: boolean; source?: string } & Record<string, unknown>
  changed_by: number | null
  note: string | null
  create_time: string
}

export const semanticApi = {
  page: (
    entityType: SemanticEntityType,
    currentPage: number,
    pageSize: number,
    params?: { scope?: string; datasource_id?: number; keyword?: string }
  ) =>
    request.get<SemanticPage<SemanticRow>>(
      `/system/semantic/page/${entityType}/${currentPage}/${pageSize}`,
      { params }
    ),
  requests: (box: 'pending' | 'mine', currentPage: number, pageSize: number) =>
    request.get<SemanticPage<SemanticChangeRequestRow>>(
      `/system/semantic/requests/${box}/${currentPage}/${pageSize}`
    ),
  versions: (entityType: SemanticEntityType, id: number) =>
    request.get<SemanticVersionRow[]>(`/system/semantic/versions/${entityType}/${id}`),
  /** Returns {applied:true,id} or {applied:false,request_id} (proposal). */
  upsert: (data: Record<string, unknown>) =>
    request.put<{ applied: boolean; id?: number; request_id?: number }>('/system/semantic', data),
  review: (data: { id: number; approve: boolean; review_note?: string }) =>
    request.put('/system/semantic/request/review', data),
  remove: (entityType: SemanticEntityType, ids: number[]) =>
    request.delete('/system/semantic', {
      params: { entity_type: entityType },
      data: ids,
    }),
  setEnabled: (entityType: SemanticEntityType, id: number, enabled: boolean) =>
    request.get(`/system/semantic/${entityType}/${id}/enable/${enabled}`),
}
