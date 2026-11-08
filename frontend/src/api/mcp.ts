import { request } from '@/utils/request'

export interface McpIntegration {
  id: number
  name: string
  description: string | null
  access_key: string
  token: string
  status: string
  last_used_at: string | null
  created_at: string
  updated_at: string
}

export interface McpIntegrationInput {
  id?: number
  name?: string
  description?: string | null
  status?: string
}

export const mcpApi = {
  list: (params?: { keyword?: string }): Promise<McpIntegration[]> =>
    request.get('/system/mcp-integration', { params }),
  create: (data: { name: string; description?: string | null }): Promise<McpIntegration> =>
    request.post('/system/mcp-integration', data),
  update: (data: McpIntegrationInput): Promise<McpIntegration> =>
    request.put('/system/mcp-integration', data),
  remove: (id: number): Promise<{ success: boolean }> =>
    request.delete(`/system/mcp-integration/${id}`),
  reveal: (id: number): Promise<{ token: string }> =>
    request.get(`/system/mcp-integration/${id}/secret`),
  rotate: (id: number): Promise<{ token: string }> =>
    request.patch(`/system/mcp-integration/secret/${id}`),
}
