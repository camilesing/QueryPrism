import { request } from '@/utils/request'

/** MetaDataImprove M7 — query budget admin API (snake_case wire). */

export type BudgetSubjectType = 'default' | 'user' | 'mcp_integration' | 'assistant'

export interface QueryBudgetRow {
  id: number
  subject_type: BudgetSubjectType
  subject_id: number | null
  daily_limit: number
  used_today: number | null
  updated_at: string
}

export const quotaApi = {
  overview: () => request.get<QueryBudgetRow[]>('/system/quota'),
  upsert: (data: {
    subject_type: BudgetSubjectType
    subject_id?: number | null
    daily_limit: number
  }) => request.put<{ id: number }>('/system/quota', data),
  remove: (id: number) => request.delete(`/system/quota/${id}`),
}
