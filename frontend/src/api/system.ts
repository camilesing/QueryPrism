import { request } from '@/utils/request'

export const modelApi = {
  queryAll: (keyword?: string) =>
    request.get('/system/aimodel', { params: keyword ? { keyword } : {} }),
  // API keys/domains travel plaintext: the backend AES-256-GCM-encrypts them
  // at rest (the old LicenseGenerator.queryprismEncrypt was an identity shim).
  add: (data: any) => request.post('/system/aimodel', data),
  edit: (data: any) => request.put('/system/aimodel', data),
  delete: (id: number) => request.delete(`/system/aimodel/${id}`),
  query: (id: number) => request.get(`/system/aimodel/${id}`),
  setDefault: (id: number) => request.put(`/system/aimodel/default/${id}`),
  check: (data: any) => request.fetchStream('/system/aimodel/status', data),
  list_by_ws: () => request.get(`/system/aimodel/list/by_ws`),
}
