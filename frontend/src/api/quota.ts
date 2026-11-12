import { request } from '@/utils/request'

/** MetaDataImprove M7 — LLM character budget admin API (snake_case wire).
 *  `daily_limit` / `used_today` are CHARACTER counts (input prompt + output
 *  content), not question counts. */

export type BudgetSubjectType = 'default' | 'user' | 'mcp_integration' | 'assistant'

export interface QueryBudgetRow {
  id: number
  subject_type: BudgetSubjectType
  subject_id: number | null
  /** Daily LLM interaction character limit. */
  daily_limit: number
  /** Characters consumed today (null = not tracked / unlimited). */
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
