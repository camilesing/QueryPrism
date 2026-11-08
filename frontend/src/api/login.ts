import { request } from '@/utils/request'
export const AuthApi = {
  login: (credentials: { username: string; password: string }) => {
    // The QueryPrism backend verifies plaintext credentials directly (bcrypt),
    // so credentials are posted as a plain JSON body (default Content-Type).
    // No login-encryption shim is needed.
    return request.post<{
      data: any
      token: string
    }>('/login/access-token', credentials)
  },
  // Pre-login forced initial-password change (called from
  // InitialPwdDialog after a need_change_pwd login response). The
  // QueryPrism backend verifies the three fields as
  // plaintext (see login above), so the body stays plain JSON.
  changePwd: (data: { account: string; pwd: string; new_pwd: string }) => {
    return request.post('/login/change-pwd', data)
  },
  logout: (data: any) => request.post('/login/logout', data),
  info: () => request.get('/user/info'),
}
