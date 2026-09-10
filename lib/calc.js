/**
 * 算分函数（源 core/utils/calc.py 逐函数直译，设计 §5.2）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。浮点取整用 Math.floor 对齐 Python math.floor。
 */
import { ACHIEVEMENT_LIST, BASE_RA_SPP } from './constants.js'

export function getBaseRa(achievements) {
  for (let i = 0; i < ACHIEVEMENT_LIST.length; i++) {
    if (achievements < ACHIEVEMENT_LIST[i]) return BASE_RA_SPP[i]
  }
  return BASE_RA_SPP[BASE_RA_SPP.length - 1]
}

/**
 * 今日舞萌运势哈希（源 core/tool.py qqhash 逐位直译，勿改动否则同人不同签）
 * @param {number} qq
 * @param {Date} [date] 日期注入口（默认当前时间；单测锁值用固定日期）
 */
export function qqhash(qq, date = new Date()) {
  const days = date.getDate() + 31 * (date.getMonth() + 1) + 77
  // Python int 为任意精度；QQ 号与 days 均在 2^53 内，乘积可能溢出——用 BigInt 对齐再截断
  return Number((BigInt(days) * BigInt(qq)) >> 8n)
}

/**
 * DX 评分星星数量（dx 为 dx 分数百分比）
 */
export function dxStar(dx) {
  if (dx <= 85) return 0
  if (dx <= 90) return 1
  if (dx <= 93) return 2
  if (dx <= 95) return 3
  if (dx <= 97) return 4
  return 5
}

/**
 * 计算底分/评价（源 compute_rating 三态重载合一）
 * @param {number} ds 定数
 * @param {number} achievement 达成率
 * @param {{onlyrate?: boolean, israte?: boolean}} opts
 *   onlyrate → 只返回评价字符串；israte → 返回 [底分, 评价]
 */
export function computeRating(ds, achievement, { onlyrate = false, israte = false } = {}) {
  let baseRating
  let rate
  if (achievement < 50) { baseRating = 7.0; rate = 'D' }
  else if (achievement < 60) { baseRating = 8.0; rate = 'C' }
  else if (achievement < 70) { baseRating = 9.6; rate = 'B' }
  else if (achievement < 75) { baseRating = 11.2; rate = 'BB' }
  else if (achievement < 80) { baseRating = 12.0; rate = 'BBB' }
  else if (achievement < 90) { baseRating = 13.6; rate = 'A' }
  else if (achievement < 94) { baseRating = 15.2; rate = 'AA' }
  else if (achievement < 97) { baseRating = 16.8; rate = 'AAA' }
  else if (achievement < 98) { baseRating = 20.0; rate = 'S' }
  else if (achievement < 99) { baseRating = 20.3; rate = 'Sp' }
  else if (achievement < 99.5) { baseRating = 20.8; rate = 'SS' }
  else if (achievement < 100) { baseRating = 21.1; rate = 'SSp' }
  else if (achievement < 100.5) { baseRating = 21.6; rate = 'SSS' }
  else { baseRating = 22.4; rate = 'SSSp' }

  if (israte) {
    return [Math.floor(ds * (Math.min(100.5, achievement) / 100) * baseRating), rate]
  }
  if (onlyrate) return rate
  return Math.floor(ds * (Math.min(100.5, achievement) / 100) * baseRating)
}
