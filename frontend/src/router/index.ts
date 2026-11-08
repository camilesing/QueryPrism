import { createRouter, createWebHashHistory } from 'vue-router'
import LayoutDsl from '@/components/layout/LayoutDsl.vue'
import SinglePage from '@/components/layout/SinglePage.vue'
import login from '@/views/login/index.vue'
import chat from '@/views/chat/index.vue'
import DashboardEditor from '@/views/dashboard/editor/index.vue'
import DashboardPreview from '@//views/dashboard/preview/SQPreviewSingle.vue'
import Dashboard from '@/views/dashboard/index.vue'
import Model from '@/views/system/model/Model.vue'
// import Embedded from '@/views/system/embedded/index.vue'
import Variables from '@/views/system/variables/index.vue'

import assistantTest from '@/views/system/embedded/Test.vue'
import assistant from '@/views/embedded/index.vue'
import EmbeddedPage from '@/views/embedded/page.vue'
import EmbeddedCommon from '@/views/embedded/common.vue'
import Member from '@/views/system/member/index.vue'
import Professional from '@/views/system/professional/index.vue'
import Training from '@/views/system/training/index.vue'
import Prompt from '@/views/system/prompt/index.vue'
import Audit from '@/views/system/audit/index.vue'
import Appearance from '@/views/system/appearance/index.vue'
import Parameter from '@/views/system/parameter/index.vue'
import Permission from '@/views/system/permission/index.vue'
import User from '@/views/system/user/User.vue'
import Workspace from '@/views/system/workspace/index.vue'
import Page401 from '@/views/error/index.vue'
import ChatPreview from '@/views/chat/preview.vue'

import { watchRouter } from './watch'
export const routes = [
  {
    path: '/login',
    name: 'login',
    component: login,
  },
  {
    path: '/chat',
    component: LayoutDsl,
    redirect: '/chat/index',
    children: [
      {
        path: 'index',
        name: 'chat',
        component: chat,
        props: (route: any) => {
          return { startChatDsId: route.query.start_chat }
        },
        meta: { title: 'menu.Data Q&A', iconActive: 'chat', iconDeActive: 'noChat' },
      },
    ],
  },
  {
    path: '/dsTable',
    component: SinglePage,
    children: [
      {
        path: ':dsId/:dsName',
        name: 'dsTable',
        component: () => import('@/views/ds/TableList.vue'),
        props: true,
      },
    ],
  },
  /* {
    path: '/ds',
    component: LayoutDsl,
    name: 'ds-menu',
    redirect: '/ds/index',
    children: [
      {
        path: 'index',
        name: 'ds',
        component: Datasource,
        meta: { title: 'menu.Data Connections', iconActive: 'ds', iconDeActive: 'noDs' },
      },
    ],
  }, */
  {
    path: '/dashboard',
    component: LayoutDsl,
    redirect: '/dashboard/index',
    children: [
      {
        path: 'index',
        name: 'dashboard',
        component: Dashboard,
        meta: {
          title: 'dashboard.dashboard',
          iconActive: 'dashboard',
          iconDeActive: 'noDashboard',
        },
      },
    ],
  },
  {
    path: '/set',
    name: 'set',
    component: LayoutDsl,
    redirect: '/set/professional',
    meta: { title: 'workspace.set', iconActive: 'set', iconDeActive: 'noSet' },
    children: [
      // 旧地址兼容：成员/权限已收进系统管理「权限管控」
      {
        path: '/set/member',
        name: 'member',
        redirect: '/system/permission-control/member',
        hidden: true,
      },
      {
        path: '/set/permission',
        name: 'permission',
        redirect: '/system/permission-control/permission',
        hidden: true,
      },
      {
        path: '/set/professional',
        name: 'professional',
        component: Professional,
        meta: { title: 'professional.professional_terminology' },
      },
      {
        path: '/set/training',
        name: 'training',
        component: Training,
        meta: { title: 'training.data_training' },
      },
      {
        path: '/set/prompt',
        name: 'prompt',
        component: Prompt,
        meta: { title: 'prompt.customize_prompt_words' },
      },
    ],
  },
  {
    path: '/canvas',
    name: 'canvas',
    component: DashboardEditor,
    meta: { title: 'canvas', icon: 'dashboard' },
  },
  {
    path: '/dashboard-preview',
    name: 'preview',
    component: DashboardPreview,
    meta: { title: 'DashboardPreview', icon: 'dashboard' },
  },
  {
    path: '/system',
    name: 'system',
    component: LayoutDsl,
    redirect: '/system/user',
    meta: { hidden: true },
    children: [
      {
        path: 'model',
        name: 'model',
        component: Model,
        meta: {
          title: 'model.ai_model_configuration',
          iconActive: 'model',
          iconDeActive: 'noModel',
        },
      },
      {
        path: 'user',
        name: 'user',
        component: User,
        meta: { title: 'user.user_management', iconActive: 'user', iconDeActive: 'noUser' },
      },
      // 旧地址兼容：工作空间入口已收进「权限管控」父菜单
      {
        path: 'workspace',
        name: 'workspace-legacy',
        redirect: '/system/permission-control/workspace',
        hidden: true,
      },
      {
        path: 'permission-control',
        name: 'permission-control',
        redirect: '/system/permission-control/workspace',
        meta: {
          title: 'system.permission_control',
          iconActive: 'workspace',
          iconDeActive: 'noWorkspace',
        },
        children: [
          {
            path: 'workspace',
            name: 'workspace',
            component: Workspace,
            meta: { title: 'user.workspace' },
          },
          {
            path: 'member',
            name: 'system-member',
            component: Member,
            meta: { title: 'workspace.member_management' },
          },
          {
            path: 'permission',
            name: 'system-permission',
            component: Permission,
            meta: { title: 'workspace.permission_configuration' },
          },
        ],
      },
      // 旧地址兼容：嵌入式管理已并入 /chat/index 侧栏的「应用集成」
      {
        path: 'embedded',
        name: 'embedded-legacy',
        redirect: '/app-integration/embedded',
        hidden: true,
      },
      {
        path: 'setting',
        meta: { title: 'system.system_settings', iconActive: 'set', iconDeActive: 'noSet' },
        redirect: 'system_/appearance',
        name: 'setting',
        children: [
          {
            path: 'appearance',
            name: 'appearance',
            component: Appearance,
            meta: { title: 'system.appearance_settings' },
          },
          {
            path: 'parameter',
            name: 'parameter',
            component: Parameter,
            meta: { title: 'parameter.parameter_configuration' },
          },
          {
            path: 'variables',
            name: 'variables',
            component: Variables,
            meta: { title: 'variables.system_variables' },
          },
        ],
      },
      {
        path: 'audit',
        name: 'audit',
        component: Audit,
        meta: { title: 'audit.system_log', iconActive: 'log', iconDeActive: 'noLog' },
      },
    ],
  },

  {
    path: '/assistant',
    name: 'assistant',
    component: assistant,
  },
  {
    path: '/embeddedPage',
    name: 'embeddedPage',
    component: EmbeddedPage,
  },
  {
    path: '/embeddedCommon',
    name: 'embeddedCommon',
    component: EmbeddedCommon,
  },
  {
    path: '/assistantTest',
    name: 'assistantTest',
    component: assistantTest,
  },
  {
    path: '/chatPreview',
    name: 'chatPreview',
    component: ChatPreview,
  },
  {
    path: '/admin-login',
    name: 'admin-login',
    component: login,
  },
  {
    path: '/401',
    name: '401',
    hidden: true,
    meta: {},
    component: Page401,
  },
]
const router = createRouter({
  history: createWebHashHistory(),
  routes,
})
watchRouter(router)
export default router
