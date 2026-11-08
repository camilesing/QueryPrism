import { useCache } from '@/utils/useCache'
import { useAppearanceStoreWithOut } from '@/stores/appearance'
import { useUserStore } from '@/stores/user'
import type { Router } from 'vue-router'
import { generateDynamicRouters } from './dynamic'
import { toLoginPage } from '@/utils/utils'

const appearanceStore = useAppearanceStoreWithOut()
const userStore = useUserStore()
const { wsCache } = useCache()
const whiteList = ['/login', '/admin-login']
const assistantWhiteList = ['/assistant', '/embeddedPage', '/embeddedCommon', '/401']

const wsAdminRouterList = ['/ds/index', '/app-integration/embedded', '/app-integration/mcp']
export const watchRouter = (router: Router) => {
  router.beforeEach(async (to: any, from: any, next: any) => {
    // Appearance is cosmetic: a failure here must never abort the navigation
    // (an aborted initial navigation leaves router-view empty → blank page).
    try {
      await appearanceStore.setAppearance()
    } catch (error) {
      console.error('[router] appearance initialization failed:', error)
    }
    if (to.path.startsWith('/login') && userStore.getUid) {
      next(to?.query?.redirect || '/')
      return
    }
    if (assistantWhiteList.includes(to.path)) {
      next()
      return
    }
    const token = wsCache.get('user.token')
    if (whiteList.includes(to.path)) {
      next()
      return
    }
    if (!token) {
      // ElMessage.error('Please login first')
      next(toLoginPage(to.fullPath))
      return
    }
    if (!userStore.getUid) {
      await userStore.info()
      generateDynamicRouters(router)
      const isFirstDynamicPath =
        to?.path &&
        ['/ds/index', '/app-integration/embedded', '/app-integration/mcp'].includes(to.path)
      if (isFirstDynamicPath) {
        if (userStore.isSpaceAdmin) {
          next({ ...to, replace: true })
          return
        }
      }
    }
    if (to.path === '/docs') {
      location.href = to.fullPath
      return
    }
    if (to.path === '/') {
      next('/chat')
      return
    }
    if (accessCrossPermission(to)) {
      // 空间管理员被平台系统页挡住时，回到其可用的「权限管控 → 成员管理」
      next(
        userStore.isSpaceAdmin && to.path.startsWith('/system')
          ? '/system/permission-control/member'
          : '/chat'
      )
      return
    }
    if (to.path === '/login' || to.path === '/admin-login') {
      console.info(from)
      next('/chat')
    } else {
      next()
    }
  })
}

// 空间管理员可进入的系统页：仅权限管控下的成员/权限
const spaceAdminSystemRouterList = [
  '/system/permission-control/member',
  '/system/permission-control/permission',
]

const isSpaceAdminSystemRouter = (to?: any) => {
  if (!to?.path) return false
  return spaceAdminSystemRouterList.some(
    (item: string) => to.path === item || to.path.startsWith(`${item}/`)
  )
}

const accessCrossPermission = (to: any) => {
  if (!to?.path) return false
  return (
    (to.path.startsWith('/system') &&
      !userStore.isAdmin &&
      !(userStore.isSpaceAdmin && isSpaceAdminSystemRouter(to))) ||
    (to.path.startsWith('/set') && !userStore.isSpaceAdmin) ||
    (isWsAdminRouter(to) && !userStore.isSpaceAdmin)
  )
}

const isWsAdminRouter = (to?: any) => {
  return wsAdminRouterList.some((item: string) => to?.path?.startsWith(item))
}
