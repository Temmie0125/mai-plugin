/**
 * 推分建议（docs/推分建议.md 实现稿）
 *
 * 纯函数、零 I/O、不依赖 `mai` 单例（曲库/成绩经参数注入）——便于离线 fixture 单测。
 *
 * 口径要点（docs/推分建议.md）：
 * - 推荐定数区间由 Rating 推算：averageDs = Rating/(22.4×50) 后取 1 位小数，
 *   候选 = [averageDs, averageDs+0.5]（夹在 1~15）。目标 Rating 缺省取当前 Rating。
 * - 推荐度二选一：
 *   · 平均达成率（默认）：曲库内嵌水鱼全服统计 `stats.avg` 降序（均值越高对多数玩家越简单）；
 *   · 定数差值：官方定数 − 拟合定数 降序（差值越大越可能以更少努力换更多 Rating）。
 * - 五个档位为**进度分带**（按用户当前达成率归档，未玩视为 0，详见 SUGGEST_TIERS）；
 *   已 ≥100.5%（鸟加）的谱面对推分无增益，不入任何档。
 * - 无统计（stats.avg / fit_diff 非正数，多为新谱）的谱面无法排序，排除。
 */
import { UTAGE_SONG_ID } from './b50Core.js'

/** 理论 Rating 上限：定数 15 × 系数 22.4 × 50 首 */
export const RATING_MAX = 16800

/**
 * 五个达成率档位（进度分带，互不重叠）：tier 为目标达成率，
 * 用户当前达成率落在 [min, max) 即归入该档。未玩（无成绩，按 0）落入最低档。
 */
export const SUGGEST_TIERS = [
  { tier: 100.5, min: 100.0, max: 100.5 },
  { tier: 100.0, min: 99.5, max: 100.0 },
  { tier: 99.5, min: 99.0, max: 99.5 },
  { tier: 99.0, min: 98.5, max: 99.0 },
  { tier: 98.5, min: 0, max: 98.5 },
]

/** 推荐方式关键词表（键转小写比对；中文无大小写，混入无妨） */
const MODE_ALIASES = new Map([
  ['平均', 'avg'], ['均值', 'avg'], ['avg', 'avg'],
  ['定数', 'diff'], ['差值', 'diff'], ['定数差值', 'diff'], ['diff', 'diff'], ['ds', 'diff'],
])

/** 用法文案（无效参数统一回这里，遵循「无静默失败」约定） */
export function suggestUsage(cmdHead) {
  return [
    '推分建议：按五个达成率档位(100.5/100.0/99.5/99.0/98.5)各推荐 5 张谱面',
    `格式：#${cmdHead} suggest [平均|定数] [目标Rating]`,
    '· 默认按全服平均达成率推荐；「定数」按官方定数与拟合定数差值推荐',
    '· 目标 Rating 为正整数(默认取当前)，用于推算推荐定数区间',
    `例：#${cmdHead} suggest`,
    `　　#${cmdHead} suggest 定数 15000`,
  ].join('\n')
}

/** 无法识别的参数（非模式词、非整数）→ 用法 + 指认坏 token */
export function suggestArgError(token, cmdHead) {
  return `无法识别的参数「${token}」！\n${suggestUsage(cmdHead)}`
}

/** 数字形态但非法（小数/负数/越界）→ 精确提示 */
export function suggestRatingError(token) {
  return `目标 Rating「${token}」无效，应为 1~${RATING_MAX} 的整数！`
}

/**
 * 解析参数串：模式词与目标 Rating 顺序任意，同类重复时后者生效
 * @param {string} raw
 * @returns {{mode:'avg'|'diff', rating?:number} | {error:'arg'|'rating', token:string}}
 */
export function parseSuggestArgs(raw) {
  const tokens = (raw || '').trim().split(/\s+/).filter(Boolean)
  let mode = null
  let rating = null
  for (const tk of tokens) {
    const m = MODE_ALIASES.get(tk.toLowerCase())
    if (m) {
      mode = m
      continue
    }
    if (/^\d+$/.test(tk)) {
      const v = parseInt(tk, 10)
      if (v < 1 || v > RATING_MAX) return { error: 'rating', token: tk }
      rating = v
      continue
    }
    // 数字形态但非法（小数/负数/带符号）→ 给 rating 提示而非笼统 usage
    if (/^[-+.]\d|^\d+\./.test(tk)) return { error: 'rating', token: tk }
    return { error: 'arg', token: tk }
  }
  return mode || rating != null
    ? { mode: mode ?? 'avg', ...(rating != null ? { rating } : {}) }
    : { mode: 'avg' }
}

/**
 * 推荐定数区间（docs/推分建议.md 公式逐字实现，另加两处收敛防区间倒挂：
 * 顶级玩家 averageDs 可能超过 15；低分端 averageDs+0.5 可能不足 1）
 * @param {number} rating 目标 Rating
 * @returns {{min:number, max:number}}
 */
export function averageDsRange(rating) {
  const averageDs = Math.round((rating / (22.4 * 50)) * 10) / 10
  const min = Math.min(15, Math.max(1, averageDs))
  const max = Math.max(min, Math.min(15, Math.round((averageDs + 0.5) * 10) / 10))
  return { min, max }
}

/**
 * 由曲库 + 全量成绩构建五档推分列表
 *
 * @param {object} opts
 * @param {{root: Array}} opts.totalList 曲库（MusicList，遍历 .root）
 * @param {Array} opts.records PlayedResult[]（全量成绩；无成绩 = 未玩）
 * @param {'avg'|'diff'} [opts.mode] 推荐方式
 * @param {{min:number, max:number}} opts.dsRange 推荐定数区间（averageDsRange 产出）
 * @param {Array} [opts.tiers] 档位表（默认 SUGGEST_TIERS，测试可注入）
 * @param {number} [opts.topN] 每档条数（默认 5）
 * @returns {{mode:string, dsRange:object, tiers:Array<{tier:number,min:number,max:number,rows:Array}>}}
 */
export function buildSuggestList({ totalList, records, mode = 'avg', dsRange, tiers = SUGGEST_TIERS, topN = 5 } = {}) {
  const recordMap = new Map((records ?? []).map(r => [`${r.song_id}-${r.level_index}`, r]))
  const buckets = tiers.map(t => ({ tier: t.tier, min: t.min, max: t.max, rows: [] }))

  for (const song of totalList.root) {
    if (song.song_id >= UTAGE_SONG_ID) continue                      // 宴谱
    for (const diff of song.difficulties) {
      if (!diff || !(diff.level_value > 0)) continue                 // 空难度位
      if (diff.level_value < dsRange.min || diff.level_value > dsRange.max) continue
      // 推荐度：缺统计（fit_diff/avg 非正数，多为新谱）无法排序，排除
      const stats = diff.stats
      const score = mode === 'diff'
        ? (stats?.fit_diff > 0 ? diff.level_value - stats.fit_diff : null)
        : (stats?.avg > 0 ? stats.avg : null)
      if (score == null) continue

      const rec = recordMap.get(`${song.song_id}-${diff.level_index}`)
      const ach = rec?.achievements ?? 0
      const bucket = buckets.find(b => ach >= b.min && ach < b.max)
      if (!bucket) continue                                          // ≥100.5：已鸟加，全档排除

      bucket.rows.push({
        song_id: song.song_id,
        song_name: song.song_name,
        type: song.type,
        level_index: diff.level_index,
        level: diff.level,
        level_value: diff.level_value,
        achievements: rec ? rec.achievements : null,                 // null = 未玩
        rate: rec?.rate ?? null,
        score,
      })
    }
  }

  // 推荐度降序；平分时定数高者优先（同 Ra 增益下更值得推）、再按 id 升序保证稳定
  for (const b of buckets) {
    b.rows.sort((x, y) => y.score - x.score || y.level_value - x.level_value || x.song_id - y.song_id)
    b.rows = b.rows.slice(0, topN)
  }
  return { mode, dsRange, tiers: buckets }
}
