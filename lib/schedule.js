/**
 * 每日同步计划（P3 实施文档 §3.2/§3.3，纯函数便于单测）
 *
 * 为什么默认 05:30：04:00–04:30 是最拥挤的窗口（xhh-plugin bili 04:00、voice/sr_strategy 04:20，
 * 且 04:00 是 Yunzai 圈惯例值），05:30 既在这批之后又留足「宿主更新 + pnpm install + 重启」的时间。
 * 注意宿主 `update_time` 是「启动后 N 分钟」的间隔模式，开火时刻不可预测、挑时间躲不掉——
 * 故本插件另一条腿是写盘原子化（见 lib/jsonFile.js）。
 *
 * 刻意只支持 HH:MM、不开放任意 cron：把「每天几点同步一次」表达清楚即可，
 * 放开 cron 只会让用户写出 `0 0 4 * * 7` 这类易错表达式。
 */

/** 出厂默认触发时间（本地时区） */
export const DEFAULT_AUTO_SYNC_TIME = '05:30'

/** node-schedule 为六段：`秒 分 时 日 月 周`（宿主 loader 取前 6 段） */
const pad2 = n => String(n).padStart(2, '0')

/**
 * 解析 HH:MM（宽松：一位数时/分均收，含全角冒号与首尾空白；越界与不可解析一律 null）
 * @returns {{hour: number, minute: number} | null}
 */
function parseHhmm(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

const cronOf = t => `0 ${t.minute} ${t.hour} * * *`
const timeOf = t => `${pad2(t.hour)}:${pad2(t.minute)}`

/**
 * '5:30' / '05:30' / '5：30' → '0 30 5 * * *'；越界或不可解析 → null
 */
export function hhmmToCron(text) {
  const t = parseHhmm(text)
  return t ? cronOf(t) : null
}

/**
 * 归一为两位 'HH:MM'；非法 → null
 */
export function toHhmm(text) {
  const t = parseHhmm(text)
  return t ? timeOf(t) : null
}

/**
 * 解析配置项 autoSyncTime → 实际生效的同步计划
 * 非法（含空值）时**回退默认值照常注册**并置 fallback=true —— 笔误不该让每日同步静默停摆，
 * 调用方负责把 fallback 打成告警让运维看到实际生效值。
 * @returns {{cron: string, time: string, fallback: boolean}}
 */
export function resolveAutoSyncCron(text) {
  const t = parseHhmm(text)
  if (t) return { cron: cronOf(t), time: timeOf(t), fallback: false }
  const d = parseHhmm(DEFAULT_AUTO_SYNC_TIME)
  return { cron: cronOf(d), time: DEFAULT_AUTO_SYNC_TIME, fallback: true }
}
