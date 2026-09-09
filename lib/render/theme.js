/**
 * 主题解析（设计 §8.2/§8.3，源 core/merge/models/enum.py:25-33）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 主题范围与源一致：仅 prism_plus / circle 两套（P0 冻结枚举，P1 接入模板变量注入）。
 */
export const THEMES = ['prism_plus', 'circle']

/** 主题枚举值校验（源 Theme.get_by_index 语义：同时接受序号「1/2」） */
export function parseTheme(input) {
  if (!input) return null
  const byIndex = { 1: THEMES[0], 2: THEMES[1] }
  const s = String(input).trim().toLowerCase()
  return THEMES.includes(s) ? s : (byIndex[s] ?? null)
}

/** 主题帮助文案（源 Theme.get_help 同款格式） */
export function themeHelp() {
  return THEMES.map((t, i) => `「${i}」：${t}`).join('\n')
}

/**
 * 主题切图目录相对 static/ 的路径前缀
 * 源：pic/<theme>/ 为主题化切图；default 场景（无主题偏好）取 prism_plus
 */
export function themePicDir(theme) {
  const t = THEMES.includes(theme) ? theme : THEMES[0]
  return `static/mai/pic/${t}`
}
