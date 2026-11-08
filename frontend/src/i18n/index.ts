import { createI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import en from './en.json'
import zhCN from './zh-CN.json'
import elementEnLocale from 'element-plus-secondary/es/locale/lang/en'
import elementZhLocale from 'element-plus-secondary/es/locale/lang/zh-cn'
import { useCache } from '@/utils/useCache'
import { getBrowserLocale, normalizeLanguage } from '@/utils/utils'

const { wsCache } = useCache()

const isEmbeddedRoute = () => {
  const hash = window.location.hash
  if (!hash) return false
  const hashPath = hash.substring(1).split('?')[0]
  return ['/assistant', '/embeddedPage', '/embeddedCommon'].includes(hashPath)
}

const getUrlLang = () => {
  try {
    const hash = window.location.hash
    if (!hash) return null
    const hashQuery = hash.substring(1).split('?')[1]
    if (!hashQuery) return null
    return new URLSearchParams(hashQuery).get('lang')
  } catch {
    return null
  }
}

const getDefaultLocale = (): 'en' | 'zh-CN' => {
  // 嵌入式页面的 URL lang 参数（第三种国际化渠道），优先级最高
  const urlLang = normalizeLanguage(getUrlLang())
  if (urlLang && isEmbeddedRoute()) {
    return urlLang
  }
  return normalizeLanguage(wsCache.get('user.language')) ?? getBrowserLocale()
}

const messages = {
  en: {
    ...en,
    el: elementEnLocale,
  },
  'zh-CN': {
    ...zhCN,
    el: elementZhLocale,
  },
}

export const i18n = createI18n({
  legacy: false,
  locale: getDefaultLocale(),
  fallbackLocale: 'en',
  globalInjection: true,
  messages,
})

const elementLocales = {
  en: elementEnLocale,
  'zh-CN': elementZhLocale,
} as const

export const getElementLocale = () => {
  const locale = i18n.global.locale.value as keyof typeof elementLocales
  return elementLocales[locale] ?? elementEnLocale
}

/** Single choke point for language changes: vue-i18n locale + dayjs locale. */
export const applyLocale = (lang: string) => {
  const locale = normalizeLanguage(lang) ?? 'en'
  i18n.global.locale.value = locale
  dayjs.locale(locale === 'zh-CN' ? 'zh-cn' : 'en')
}

applyLocale(i18n.global.locale.value)
