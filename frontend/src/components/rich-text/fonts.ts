// Shared TinyMCE font catalog + locale probe. The Chinese-font entries are
// only shown for the zh locale (their display names are the proper Chinese
// names of those font families); latin fonts always show.
import { i18n } from '@/i18n'

export const isZh = () => i18n.global.locale.value === 'zh-CN'

export const CN_FONT_BLOCK =
  '微软雅黑=Microsoft YaHei;宋体=SimSun;黑体=SimHei;仿宋=FangSong;华文黑体=STHeiti;华文楷体=STKaiti;华文宋体=STSong;华文仿宋=STFangsong;'
export const LATIN_FONT_BLOCK =
  'Andale Mono=andale mono,times;Arial=arial,helvetica,sans-serif;Arial Black=arial black,avant garde;Book Antiqua=book antiqua,palatino;Comic Sans MS=comic sans ms,sans-serif;Courier New=courier new,courier;Georgia=georgia,palatino;Helvetica=helvetica;Impact=impact,chicago;Symbol=symbol;Tahoma=tahoma,arial,helvetica,sans-serif;Terminal=terminal,monaco;Times New Roman=times new roman,times;Trebuchet MS=trebuchet ms,geneva;Verdana=verdana,geneva;Webdings=webdings;Wingdings=wingdings'
