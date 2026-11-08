// 工业蓝灰 HMI 主题预设。'default' 是出厂色（工业蓝）；'green' 保留原品牌绿；
// 'blue' 保留原科技蓝；'custom' 走 appearanceStore.customColor。
export const THEME_PRESET_COLORS = {
  default: '#2563EB',
  green: '#1CBA90',
  blue: '#3370ff',
} as const

export const resolveThemeColor = (themeColor?: string, customColor?: string): string => {
  if (themeColor === 'custom' && customColor) {
    return customColor
  }
  if (themeColor === 'blue') {
    return THEME_PRESET_COLORS.blue
  }
  if (themeColor === 'green') {
    return THEME_PRESET_COLORS.green
  }
  return THEME_PRESET_COLORS.default
}
