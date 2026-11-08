import 'core-js/features/object/has-own'
// @ts-ignore: css-has-pseudo/browser lacks official type definitions
import cssHasPseudo from 'css-has-pseudo/browser'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.less'
// 侧栏 ElMenu 在脚本里显式 import，不经过 unplugin 按需注入，需手动引入基础样式
import 'element-plus-secondary/theme-chalk/el-menu.css'
import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import VueDOMPurifyHTML from 'vue-dompurify-html'
import { isSupportFlexGap } from './utils/utils'

// import 'element-plus/dist/index.css'
cssHasPseudo(document)

isSupportFlexGap()

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(i18n)
app.use(VueDOMPurifyHTML)
app.mount('#app')
