/**
 * 拟合 B50 计算（设计《拟合b50实现设计.md》§4 二稿 / 《b50扩展实现设计.md》§4.1）
 *
 * 纯函数、零 I/O、不依赖 `mai` 单例（曲库经 deps 注入）——便于离线 fixture 单测。
 *
 * 口径要点：
 * - 分池依据是曲库 `isnew`（**不是** SD/DX，那只是查分器对外的历史叫法）：
 *   `isnew: true` → 新版 15 位池，`false` → 旧版 35 位池。与既有 drawChartInfo 一致。
 *   ⚠️ `isnew` 来源不对称（df 的 is_new 旗标优先，仅落雪独有曲才本地推算），
 *   见 lib/merge/merge.js:74/144 —— 一律**读取**，勿本地重算。
 * - 拟合 Rating = `computeRating(精确拟合定数, 达成率)`，向下取整，与真实 Rating 同一公式。
 * - 分池/排序/截断已下沉到 lib/b50Core.js（与随心配变体共用）；本文件只负责
 *   「按拟合口径过滤 + 覆写 rating」这一段。
 */
import { computeRating } from './calc.js'
import { rankBest50, DX_SLOTS, SD_SLOTS, UTAGE_SONG_ID } from './b50Core.js'

// 既有导出面保持不变（tests/fit.test.js 直接从这里取两个位次常量）
export { SD_SLOTS, DX_SLOTS }

/**
 * 由全量成绩算出拟合 B50
 *
 * @param {Array} records PlayedResult[]（真实成绩；level_value/rating 会被覆写为拟合口径）
 * @param {{ totalList: {byId: (id:number) => object|null} }} deps 曲库（测试注入）
 * @returns {{ best50: {sd_total:number,dx_total:number,sd:Array,dx:Array},
 *             fitTotal:number, candidates:number }}
 *   candidates = 参与排序的谱面总数；为 0 时调用方回「无可拟合成绩」文案
 */
export function fitBest50(records, deps = {}) {
  const { totalList } = deps
  const entries = []
  let candidates = 0

  for (const r of records ?? []) {
    if (r.song_id >= UTAGE_SONG_ID) continue                       // 宴谱
    const song = totalList?.byId(r.song_id)
    if (!song) continue                                            // 曲库未收录/已下架
    const diff = song.difficulties?.[r.level_index]
    if (!diff) continue                                            // 难度位越界
    const fitDiff = diff.stats?.fit_diff
    // 无 stats 或 fit_diff 非正数（实测 7 张是「有 stats 但 fit_diff 为 0」）→ 不参与排序
    if (!(fitDiff > 0)) continue

    entries.push({
      isnew: song.isnew,
      item: {
        ...r,
        // 覆写为拟合口径；其余字段（achievements/fc/fs/dx_score/rate…）保留真实值供展示
        level_value: fitDiff,
        rating: computeRating(fitDiff, r.achievements),
      },
    })
    candidates += 1
  }

  const { best50, total } = rankBest50(entries)
  return { best50, fitTotal: total, candidates }
}
