<script lang="ts" setup>
import { computed } from 'vue'
import { ElMenu } from 'element-plus-secondary'
import { useRoute, useRouter } from 'vue-router'
import MenuItem from './MenuItem.vue'
import { useUserStore } from '@/stores/user'
// import { routes } from '@/router'
const userStore = useUserStore()
const router = useRouter()
defineProps({
  collapse: Boolean,
})

const route = useRoute()
// const menuList = computed(() => route.matched[0]?.children || [])
const activeMenu = computed(() => route.path)
/* const activeIndex = computed(() => {
  const arr = route.path.split('/')
  return arr[arr.length - 1]
}) */
const showSysmenu = computed(() => {
  return route.path.includes('/system')
})

const formatRoute = (arr: any, parentPath = '') => {
  return arr.map((element: any) => {
    let children: any = []
    const path = `${parentPath ? parentPath + '/' : ''}${element.path}`
    if (element.children?.length) {
      children = formatRoute(element.children, path)
    }
    return {
      ...element,
      path,
      children,
    }
  })
}

const routerList = computed(() => {
  if (showSysmenu.value) {
    const [sysRouter] = formatRoute(
      router.getRoutes().filter((route: any) => route?.name === 'system')
    )
    if (!userStore.isAdmin) {
      // 空间管理员只开放权限管控下的成员/权限，不暴露平台级系统菜单
      const permissionControl = sysRouter.children.find(
        (route: any) => route.name === 'permission-control'
      )
      if (!permissionControl) return []
      return [
        {
          ...permissionControl,
          children: permissionControl.children.filter((route: any) =>
            ['system-member', 'system-permission'].includes(route.name)
          ),
        },
      ]
    }
    return sysRouter.children
  }
  const list = router.getRoutes().filter((route: any) => {
    return (
      !route.path.includes('embeddedPage') &&
      !route.path.includes('assistant') &&
      !route.path.includes('embeddedPage') &&
      !route.path.includes('canvas') &&
      !route.path.includes('member') &&
      !route.path.includes('401') &&
      !route.path.includes('training') &&
      !route.path.includes('prompt') &&
      !route.path.includes('permission') &&
      !route.path.includes('embeddedCommon') &&
      !route.path.includes('preview') &&
      !route.path.includes('audit') &&
      route.path !== '/login' &&
      route.path !== '/admin-login' &&
      route.path !== '/chatPreview' &&
      !route.path.includes('/system') &&
      (route.meta?.alwaysShow ||
        (route.path.includes('set') && userStore.isSpaceAdmin) ||
        !route.redirect) &&
      route.path !== '/:pathMatch(.*)*' &&
      !route.path.includes('dsTable') &&
      // /set children render inside the /set submenu; without this every new
      // admin page also appears as a top-level item.
      !route.path.startsWith('/set/')
    )
  })

  // meta.alwaysShow 的路由只作为父级分组展示，其子项不重复出现在一级菜单
  const groupedChildNames = new Set<any>()
  list.forEach((route: any) => {
    if (route.meta?.alwaysShow) {
      route.children?.forEach((child: any) => {
        if (child.name) {
          groupedChildNames.add(child.name)
        }
      })
    }
  })

  return list.filter((route) => !route.name || !groupedChildNames.has(route.name))
})
</script>

<template>
  <el-menu :default-active="activeMenu" class="el-menu-demo ed-menu-vertical" :collapse="collapse">
    <MenuItem v-for="menu in routerList" :key="menu.path" :menu="menu"></MenuItem>
  </el-menu>
</template>

<style lang="less">
.ed-menu-vertical {
  --ed-menu-item-height: 40px;
  --ed-menu-bg-color: transparent;
  --ed-menu-base-level-padding: 4px;
  border-right: none;
  .ed-menu-item {
    height: 40px !important;
    border-radius: 6px !important;
    margin-bottom: 2px;
    border-left: 3px solid transparent;
    // 分叉组件浅色菜单硬编码 #1f2329（CSS 变量打不动），深铬边上需显式覆盖
    color: var(--chrome-text, #94a3b8) !important;

    // 菜单图标是内联 SVG：未激活硬编码 fill=#1F2329、激活默认黑，深铬上不可见；
    // CSS fill 可覆盖内联 SVG 的 fill 表现属性
    .ed-icon svg path {
      fill: var(--chrome-text, #94a3b8);
    }

    &:hover {
      background-color: var(--chrome-hover, #334155) !important;
      color: var(--chrome-text-strong, #f8fafc) !important;

      .ed-icon svg path {
        fill: var(--chrome-text-strong, #f8fafc);
      }
    }

    &.is-active {
      background-color: var(--chrome-hover, #334155) !important;
      border-left: 3px solid var(--accent-warning, #f97316);
      color: var(--chrome-text-strong, #f8fafc) !important;
      font-weight: 500;

      .ed-icon svg path {
        fill: var(--chrome-text-strong, #f8fafc);
      }
    }
  }

  .ed-sub-menu .ed-sub-menu__title {
    border-radius: 6px;
    border-left: 3px solid transparent;
    color: var(--chrome-text, #94a3b8) !important;

    .ed-icon svg path {
      fill: var(--chrome-text, #94a3b8);
    }

    &:hover {
      background-color: var(--chrome-hover, #334155) !important;
      color: var(--chrome-text-strong, #f8fafc) !important;

      .ed-icon svg path {
        fill: var(--chrome-text-strong, #f8fafc);
      }
    }
  }

  .ed-sub-menu.is-active:not(.is-opened) {
    .ed-sub-menu__title {
      background-color: var(--chrome-hover, #334155) !important;
      border-left: 3px solid var(--accent-warning, #f97316);
      color: var(--chrome-text-strong, #f8fafc) !important;
      font-weight: 500;

      .ed-icon svg path {
        fill: var(--chrome-text-strong, #f8fafc);
      }
    }
  }

  .ed-sub-menu.is-active.is-opened {
    .ed-sub-menu__title {
      color: var(--chrome-text-strong, #f8fafc) !important;
      font-weight: 500;
    }
  }

  .ed-sub-menu .ed-icon {
    margin-right: 8px;
  }
}
.ed-popper.is-light:has(.ed-menu--popup) {
  border: 1px solid #dee0e3;
  border-radius: 6px;
  box-shadow: 0px 4px 8px 0px #1f23291a;
  background: #eff1f0;
  overflow: hidden;
}
.ed-menu--popup {
  padding: 8px;
  background: #eff1f0;

  .ed-menu-item {
    padding: 9px 16px;
    height: 40px !important;
    border-radius: 6px;
    &.is-active {
      background-color: #fff !important;
      font-weight: 500;
    }
  }
}
.ed-sub-menu {
  .subTitleMenu {
    display: none;
  }
}

.ed-menu--popup-container .subTitleMenu {
  color: #646a73 !important;
  pointer-events: none;
}
</style>
