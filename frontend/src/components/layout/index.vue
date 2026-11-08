<template>
  <div class="app-container" :class="{ 'app-topbar-container': topLayout }">
    <div
      class="main-menu"
      :class="{ 'main-menu-sidebar': !topLayout, 'main-menu-topbar': topLayout }"
    >
      <div class="logo">QueryPrism</div>

      <!-- <div v-if="!topLayout || !showSubmenu"
           :class="{ 'workspace-area': !topLayout, 'topbar-workspace-area': topLayout }">
        <el-select
            v-model="workspace"
            placeholder="Select"
            class="workspace-select"
            style="width: 240px"
        >
          <template #label="{ label }">
            <div class="workspace-label">
              <el-icon>
                <folder/>
              </el-icon>
              <span>{{ label }}</span>
            </div>
          </template>
          <el-option
              v-for="item in options"
              :key="item.value"
              :label="item.label"
              :value="item.value"
          />
        </el-select>
      </div> -->
      <el-menu
        v-if="!topLayout || !showSubmenu"
        :default-active="activeMenu"
        class="menu-container"
        :mode="topLayout ? 'horizontal' : 'vertical'"
      >
        <el-menu-item
          v-for="item in routerList"
          :key="item.path"
          :index="item.path"
          @click="menuSelect"
        >
          <el-icon v-if="item.meta.icon">
            <component :is="resolveIcon(item.meta.icon)" />
          </el-icon>
          <span>{{ t(item.meta.title as string) }}</span>
        </el-menu-item>
      </el-menu>

      <div v-else class="top-bar-title">
        <span class="split" />
        <span>{{ t('common.system_manage') }}</span>
      </div>

      <div v-if="topLayout" class="main-topbar-right">
        <div v-if="showSubmenu" class="top-back-area">
          <el-button type="primary" text="primary" @click="backMain">
            <el-icon class="el-icon--right">
              <ArrowLeftBold />
            </el-icon>
            {{ t('common.back') }}
          </el-button>
        </div>

        <el-tooltip v-else :content="t('common.system_manage')" placement="bottom">
          <div class="header-icon-btn" @click="toSystem">
            <el-icon>
              <iconsystem />
            </el-icon>
          </div>
        </el-tooltip>

        <el-dropdown trigger="click">
          <div class="user-info">
            <el-avatar size="small">{{ name?.charAt(0) }}</el-avatar>
            <span class="user-name">{{ name }}</span>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="switchLayout">Switch Layout</el-dropdown-item>
              <el-dropdown-item @click="logout">Logout</el-dropdown-item>
              <el-dropdown-item>
                <language-selector />
              </el-dropdown-item>
              <el-dropdown-item @click="toAbout">About</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <div class="main-content" :class="{ 'main-content-with-bar': topLayout }">
      <div v-if="!topLayout" class="header-container">
        <div class="header">
          <h1>{{ currentPageTitle }}</h1>
          <div class="header-actions">
            <el-tooltip content="System manage" placement="bottom">
              <div class="header-icon-btn" @click="toSystem">
                <el-icon>
                  <iconsystem />
                </el-icon>
                <span>{{ t('common.system_manage') }}</span>
              </div>
            </el-tooltip>

            <el-dropdown trigger="click">
              <div class="user-info">
                <el-avatar size="small">{{ name?.charAt(0) }}</el-avatar>
                <span class="user-name">{{ name }}</span>
              </div>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="switchLayout">Switch Layout</el-dropdown-item>
                  <el-dropdown-item @click="logout">Logout</el-dropdown-item>
                  <el-dropdown-item>
                    <language-selector />
                  </el-dropdown-item>
                  <el-dropdown-item @click="toAbout">About</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </div>

      <div v-if="sysRouterList.length && showSubmenu" class="sub-menu-container">
        <el-menu
          :default-active="activeMenu"
          class="el-menu-demo"
          :mode="!topLayout ? 'horizontal' : 'vertical'"
        >
          <el-menu-item
            v-for="item in sysRouterList"
            :key="item.path"
            :index="item.path"
            @click="menuSelect"
          >
            <el-icon v-if="item.meta.icon">
              <component :is="resolveIcon(item.meta.icon)" />
            </el-icon>
            <span>{{ t(item.meta.title as string) }}</span>
          </el-menu-item>
        </el-menu>
      </div>

      <div v-if="sysRouterList.length && showSubmenu" class="sys-page-content">
        <div class="sys-inner-container">
          <router-view />
        </div>
      </div>
      <div v-else class="page-content">
        <router-view />
      </div>
    </div>
  </div>
  <AboutDialog ref="aboutRef" />
</template>

<script lang="ts" setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/stores/user'
import ds from '@/assets/svg/ds.svg'
import dashboard from '@/assets/svg/dashboard.svg'
import chat from '@/assets/svg/chat.svg'
import iconsetting from '@/assets/svg/setting.svg'
import iconsystem from '@/assets/svg/system.svg'
import icon_user from '@/assets/svg/icon_user.svg'
import icon_ai from '@/assets/svg/icon_ai.svg'
import { ArrowLeftBold } from '@element-plus/icons-vue'
import { useCache } from '@/utils/useCache'
import { useI18n } from 'vue-i18n'
import LanguageSelector from '@/components/Language-selector/index.vue'
import AboutDialog from '@/components/about/index.vue'

const aboutRef = ref()
const { t } = useI18n()
const { wsCache } = useCache()
const topLayout = ref(false)
const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const name = ref('admin')
const activeMenu = computed(() => route.path)
const routerList = computed(() => {
  return router.getRoutes().filter((route) => {
    return (
      !route.path.includes('canvas') &&
      !route.path.includes('preview') &&
      route.path !== '/login' &&
      !route.path.includes('/system') &&
      !route.redirect &&
      route.path !== '/:pathMatch(.*)*' &&
      !route.path.includes('dsTable')
    )
  })
})

const sysRouterList = computed(() => {
  const result = router
    .getRoutes()
    .filter((route) => route.path.includes('/system') && !route.redirect)
  return result
})

const showSubmenu = computed(() => {
  return route.path.includes('/system')
})
// const workspace = ref('1')
/* const options = [
  {value: '1', label: 'Default workspace'},
  {value: '2', label: 'Workspace 2'},
  {value: '3', label: 'Workspace 3'}
] */
const currentPageTitle = computed(() => {
  if (route.path.includes('/system')) {
    return t('system.system_settings')
  }
  // meta.title holds the raw i18n key (8885a81a) — translate reactively so
  // the header follows language switches instead of the module-load locale
  return route.meta.title ? t(route.meta.title as string) : 'Dashboard'
})
const resolveIcon = (iconName: any) => {
  const icons: Record<string, any> = {
    ds: ds,
    dashboard: dashboard,
    chat: chat,
    setting: iconsetting,
    icon_user: icon_user,
    icon_ai: icon_ai,
  }
  return typeof icons[iconName] === 'function' ? icons[iconName]() : icons[iconName]
}

const menuSelect = (e: any) => {
  router.push(e.index)
}
const logout = async () => {
  if (!(await userStore.logout())) {
    router.push('/login')
  }
}
const toSystem = () => {
  router.push('/system')
}
const backMain = () => {
  router.push('/')
}
const switchLayout = () => {
  topLayout.value = !topLayout.value
  wsCache.set('queryprism-topbar-layout', topLayout.value)
}
const toAbout = () => {
  aboutRef.value?.open()
}
onMounted(() => {
  topLayout.value = wsCache.get('queryprism-topbar-layout') || true
})
</script>

<style lang="less" scoped>
.app-topbar-container {
  flex-direction: column;
}

.app-container {
  display: flex;
  height: 100vh;

  .main-menu {
    display: flex;

    .workspace-area {
      margin: 8px 16px;
      width: 208px;
      overflow: hidden;

      .workspace-select {
        width: 100% !important;

        :deep(.ed-select__wrapper) {
          border-radius: 8px;
          box-shadow: none !important;
          background-color: #f1f3f4;
          line-height: 32px;
          min-height: 48px;

          .ed-select__selected-item {
            height: 32px;
          }

          .workspace-label {
            color: #2d2e31;
            font-weight: 600;
            display: flex;
            column-gap: 8px;
            align-items: center;
            height: 32px;
          }
        }
      }
    }

    .logo {
      height: 68px;
      line-height: 68px;
      font-size: 22px;
      font-weight: bold;
      letter-spacing: 0.5px;
      color: var(--chrome-text-strong, #f8fafc);
      text-align: left;
      margin-left: 24px;
      border-left: 3px solid var(--accent-warning, #f97316);
      padding-left: 12px;
      margin-top: 8px;
    }

    .menu-container {
      flex: 1;
      border-right: none;
      border-bottom: none;
      // element-plus-secondary 混用 --el-* / --ed-*，两组都设，宁多勿漏
      --el-menu-bg-color: transparent;
      --el-menu-text-color: #94a3b8;
      --el-menu-hover-bg-color: #334155;
      --el-menu-active-color: #f8fafc;
      --el-menu-hover-text-color: #f8fafc;
      --ed-menu-bg-color: transparent;
      --ed-menu-text-color: #94a3b8;
      --ed-menu-hover-bg-color: #334155;
      --ed-menu-active-color: #f8fafc;

      &:not(.ed-menu--vertical) {
        margin-left: 32px;
      }

      :deep(.ed-menu-item.is-active) {
        border-left: 3px solid var(--accent-warning, #f97316);
        background: #334155;
        color: #f8fafc;
      }

      :deep(.ed-menu-item) {
        border-left: 3px solid transparent;
      }
    }
  }

  .main-menu-sidebar {
    width: 240px;
    background: var(--chrome-bg, #1e293b);
    border-right: 1px solid var(--chrome-bg-deep, #0f172a);
    box-shadow: none;
    display: flex;
    flex-direction: column;
    z-index: 2;

    .ed-menu--vertical {
      padding: 0 16px;
    }
  }

  .main-menu-topbar {
    height: 60px;
    line-height: 60px;
    font-size: 22px;
    font-weight: bold;
    color: var(--chrome-text-strong, #f8fafc);
    justify-content: space-between;
    background: var(--chrome-bg, #1e293b);
    border-bottom: 1px solid var(--chrome-bg-deep, #0f172a);
    box-shadow: none;
    z-index: 2;
    text-align: center;

    .logo {
      height: 60px;
      line-height: 60px;
      border-left: none;
      border-bottom: 3px solid transparent;
      padding-left: 0;
      margin-top: 0;
      margin-left: 24px;
    }

    .menu-container {
      border-bottom: none;
      margin-left: 0;

      :deep(.ed-menu-item) {
        border-left: none;
        border-bottom: 3px solid transparent;
      }

      :deep(.ed-menu-item.is-active) {
        border-bottom: 3px solid var(--accent-warning, #f97316);
        background: transparent;
        color: #f8fafc;
      }
    }

    .main-topbar-right {
      display: flex;
      height: 60px;
      align-items: center;
      padding-right: 24px;

      .header-icon-btn {
        display: flex;
        column-gap: 12px;
        align-items: center;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        border: none;
        font-weight: 500;
        transition: all 0.3s;
        font-size: 14px;
        color: #94a3b8;

        &:hover {
          background-color: #334155;
          color: #f8fafc;
        }
      }

      :deep(.user-info) {
        display: flex;
        column-gap: 4px;
        align-items: center;

        .ed-avatar {
          background-color: var(--ed-color-primary, #2563eb);
          color: #fff;
        }

        .user-name {
          font-size: 14px;
          font-weight: 500;
          color: #f8fafc;
        }
      }

      .top-back-area {
        align-items: center;
        display: flex;

        :deep(.ed-button) {
          color: #f8fafc;
        }
      }
    }

    .topbar-workspace-area {
      margin: 0 32px;
      height: auto;
      width: 208px;
      line-height: 54px;

      .workspace-select {
        width: 100% !important;

        :deep(.ed-select__wrapper) {
          border-radius: 4px;
          box-shadow: none !important;
          background-color: #334155;
          line-height: 24px;
          min-height: 32px;

          .workspace-label {
            color: #f8fafc;
            font-weight: 600;
            display: flex;
            column-gap: 8px;
            align-items: center;
            height: 32px;
          }
        }
      }
    }

    .top-bar-title {
      font-size: 14px;
      color: #94a3b8;
      display: flex;
      align-items: center;
      left: 132px;
      width: 200px;
      position: fixed;

      .split {
        color: #475569;
        border: 0.5px solid;
        margin-right: 16px;
        height: 12px;
      }
    }
  }

  .main-content {
    width: calc(100% - 288px);
    height: 100vh;
    flex: 1;
    display: flex;
    flex-direction: column;
    background-color: var(--bg-color, #f1f5f9);
    box-sizing: border-box;

    &:not(.main-content-with-bar) {
      padding: 16px 24px;
    }

    .header-container {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      height: 60px;
      font-family:
        -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell,
        'Open Sans', 'Helvetica Neue', sans-serif;

      .header {
        height: 36px;
        line-height: 36px;
        color: #0f172a;

        h1 {
          font-size: 24px;
          font-weight: 500;
          height: 36px;
          line-height: 36px;
        }

        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 24px;

        .header-actions {
          display: flex;
          height: 36px;
          align-items: center;

          .header-icon-btn {
            display: flex;
            column-gap: 12px;
            align-items: center;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            border: none;
            font-weight: 500;
            transition: all 0.3s;
            font-size: 14px;
            color: #475569;

            &:hover {
              background-color: #e2e8f0;
            }
          }

          :deep(.user-info) {
            display: flex;
            column-gap: 4px;
            align-items: center;

            .ed-avatar {
              background-color: var(--el-color-primary);
              color: #fff;
            }

            .user-name {
              font-size: 14px;
              font-weight: 500;
              color: #0f172a;
            }
          }
        }
      }
    }

    .page-content {
      flex: 1;
      overflow-y: auto;
    }

    .sys-page-content {
      background-color: var(--white);
      border-radius: var(--border-radius);
      padding: 24px;
      box-shadow: var(--shadow);
      margin-top: 24px;
      flex: 1;

      .sys-inner-container {
        background: #fff;
        border-radius: 8px;
        padding: 20px;
        box-shadow: var(--shadow);
      }
    }

    .sub-menu-container {
      overflow: hidden;
      border-radius: 8px;
    }
  }

  .main-content-with-bar {
    height: 0;
    flex: 1;
    width: 100%;
    display: flex;
    flex-direction: row;

    .sub-menu-container {
      flex: 0 0 auto;
      resize: horizontal;
      overflow: auto;
      border-right: 1px solid var(--el-menu-border-color);
      border-radius: 0;
      background-color: var(--white);

      :deep(.ed-menu) {
        border: none;
      }
    }

    .sys-page-content {
      margin: 0;
      border-radius: 0;
      width: calc(100% - 288px);
    }
  }
}
</style>
