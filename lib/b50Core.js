/**
 * B50 排名核心（设计《b50扩展实现设计.md》§4.1）
 *
 * 拟合b50 与随心配变体共用的「候选 → Best50」这一段：分池 / 降序排序 / 截断 / 合计。
 * 纯函数、零 I/O、不依赖 `mai` 单例（曲库由调用方消化成 entries 后传入）。
 *
 * ⚠️ 分池口径与真实 B50 完全一致（读曲库 `isnew`，**不是** SD/DX——那只是查分器对外的历史叫法）：
 *    `isnew: true` → B15（15 格），`false` → B35（35 格）。
 *    变体**不得**改这里的分池规则：变体要变的只是「哪些成绩有资格进候选」，见 lib/variantB50.js。
 */
import { Best50 } from './merge/models.js'

/** B35 / B15 位次（与真实 B50 同规则） */
export const SD_SLOTS = 35
export const DX_SLOTS = 15

/** 宴谱起始 song_id（官方 DX Rating 不含宴谱，一律排除） */
export const UTAGE_SONG_ID = 100000

/** rating 降序；Array.prototype.sort 稳定 ⇒ 同分保持入参顺序 */
const byRatingDesc = (a, b) => b.rating - a.rating

const sumRating = list => list.reduce((acc, x) => acc + x.rating, 0)

/**
 * 组装 Best50 领域对象 + 合计
 *
 * 供 rankBest50 与「重复填充」模式（歌50）共用，保证两条路径的 totals 口径一致。
 * @param {Array} sd 已在 35 位内的成绩（调用方保证）
 * @param {Array} dx 已在 15 位内的成绩
 * @returns {{best50: {sd_total:number,dx_total:number,sd:Array,dx:Array}, total:number}}
 */
export function buildBest50(sd, dx) {
  const best50 = Best50({
    sd_total: sumRating(sd),
    dx_total: sumRating(dx),
    sd,
    dx,
  })
  return { best50, total: best50.sd_total + best50.dx_total }
}

/**
 * 候选 → Best50（分池、各池按 rating 降序取前 35 / 前 15）
 *
 * @param {Array<{isnew: boolean, item: object}>} entries 已过滤的候选（item 通常就是 PlayedResult）
 * @returns {{best50: {sd_total:number,dx_total:number,sd:Array,dx:Array}, total:number}}
 */
export function rankBest50(entries) {
  const sd = []
  const dx = []
  for (const e of entries ?? []) (e.isnew ? dx : sd).push(e.item)
  sd.sort(byRatingDesc)
  dx.sort(byRatingDesc)
  return buildBest50(sd.slice(0, SD_SLOTS), dx.slice(0, DX_SLOTS))
}
