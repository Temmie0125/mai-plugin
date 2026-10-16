/**
 * 推分建议（docs/推分建议.md 实现稿）
 *
 * 纯函数、零 I/O、不依赖 `mai` 单例（曲库/成绩经参数注入）——便于离线 fixture 单测。
 *
 * 口径要点：
 * - 阈值 Rating：缺省取当前 Rating **向上取整到的下一个 500 档**（12500 → 13000、12345 → 12500），
 *   可由命令参数显式指定（不得低于当前 Rating）。
 * - 推荐定数窗口：baseDs = 阈值/(22.4×50)（1 位小数，夹 1~15）。第 k 档（k=0 为 100.5 档）
 *   窗口宽 1.0 定数、中心 = baseDs + 0.2×(k+1)——目标每降一档窗口上移 0.2，最低档（98.5）
 *   中心 = baseDs+1.0。五档窗口重叠衔接，联合覆盖 [baseDs−0.3, baseDs+1.7)：候选是窗口内
 *   **全部谱面**（玩过 + 未玩，相对旧版只从进度带里的已玩谱面选取），上探幅度收敛在
 *   baseDs+1.5 以内，防越级。
 * - 每档入选条件：定数落在本档窗口，且当前达成率 < 目标档位（未玩按 0，已达该档无推分空间）。
 *   「打到 98.5 推不了分、直接鸟加反而能推」由窗口归属呈现：同一张谱面按定数落位，
 *   在它能被推上去的目标档里出现（可同时出现在多个目标档）。
 * - 首先排除宴谱与新歌（isnew，当前版本池，拟合数据未稳）。
 * - 推荐度二选一：定数差值（默认，官方定数 − 拟合定数 降序，差值越大越可能以更少努力换更多
 *   Rating）/ 平均达成率（stats.avg 降序，均值越高对多数玩家越简单）。缺统计（fit_diff / avg
 *   非正数）的谱面无法排序，排除。
 */
import { UTAGE_SONG_ID } from './b50Core.js'

/** 理论 Rating 上限：定数 15 × 系数 22.4 × 50 首 */
export const RATING_MAX = 16800

/** 五个目标档位（达成率，降序；推荐定数窗口自 100.5 档起每降一档上移 0.2） */
export const SUGGEST_TIERS = [100.5, 100.0, 99.5, 99.0, 98.5]

/** 档位窗口参数（0.1 定数格）：半宽 5（±0.5），中心每降一档上移 2（+0.2） */
const WINDOW_HALF = 5
const TIER_DS_STEP = 2

/** 默认阈值：当前 Rating 向上取到下一个 500 档（12500 → 13000、12345 → 12500） */
export function defaultRatingThreshold(rating) {
  return (Math.floor(rating / 500) + 1) * 500
}

/** 阈值 Rating → 平均定数（docs/推分建议.md 公式，夹在 1~15） */
export function thresholdBaseDs(thresholdRating) {
  const averageDs = Math.round((thresholdRating / (22.4 * 50)) * 10) / 10
  return Math.min(15, Math.max(1, averageDs))
}

/** 推荐方式关键词表（键转小写比对；中文无大小写，混入无妨） */
const MODE_ALIASES = new Map([
  ['平均', 'avg'], ['均值', 'avg'], ['avg', 'avg'],
  ['定数', 'diff'], ['差值', 'diff'], ['定数差值', 'diff'], ['diff', 'diff'], ['ds', 'diff'],
])

/** 用法文案（无效参数统一回这里，遵循「无静默失败」约定） */
export function suggestUsage(cmdHead) {
  return [
    '推分建议：按五个达成率目标档位(100.5/100.0/99.5/99.0/98.5)各推荐 5 张谱面',
    `格式：#${cmdHead} suggest [平均|定数] [阈值Rating]`,
    '· 默认按定数差值(官方定数−拟合定数)推荐；「平均」按全服平均达成率推荐',
    '· 阈值 Rating 为正整数(缺省取当前向上取整到下一 500 档)，决定各档推荐定数窗口',
    `例：#${cmdHead} suggest`,
    `　　#${cmdHead} suggest 平均 15000`,
  ].join('\n')
}

/** 无法识别的参数（非模式词、非整数）→ 用法 + 指认坏 token */
export function suggestArgError(token, cmdHead) {
  return `无法识别的参数「${token}」！\n${suggestUsage(cmdHead)}`
}

/** 数字形态但非法（小数/负数/越界）→ 精确提示 */
export function suggestRatingError(token) {
  return `阈值 Rating「${token}」无效，应为 1~${RATING_MAX} 的整数！`
}

/**
 * 解析参数串：模式词与阈值 Rating 顺序任意，同类重复时后者生效
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
    ? { mode: mode ?? 'diff', ...(rating != null ? { rating } : {}) }
    : { mode: 'diff' }
}

/**
 * 由曲库 + 全量成绩构建五档推分列表
 *
 * @param {object} opts
 * @param {{root: Array}} opts.totalList 曲库（MusicList，遍历 .root）
 * @param {Array} opts.records PlayedResult[]（全量成绩；无成绩 = 未玩）
 * @param {'avg'|'diff'} [opts.mode] 推荐方式
 * @param {number} opts.thresholdRating 阈值 Rating（决定各档定数窗口与 Ra 均摊线）
 * @param {Array} [opts.tiers] 目标档位表（默认 SUGGEST_TIERS，测试可注入）
 * @param {number} [opts.topN] 每档条数（默认 5）
 * @returns {{mode:string, thresholdRating:number, baseDs:number, tiers:Array<
 *   {tier:number, lo:number, hi:number, rows:Array}>}} lo/hi 为 0.1 定数格的整数半开区间
 */
export function buildSuggestList({ totalList, records, mode = 'diff', thresholdRating, tiers = SUGGEST_TIERS, topN = 5 } = {}) {
  const recordMap = new Map((records ?? []).map(r => [`${r.song_id}-${r.level_index}`, r]))
  // 窗口边界整数化到 0.1 定数格比较：谱面定数与公式结果都是 1 位小数，规避浮点误差。
  // 第 k 档中心 = baseDs + 0.2×(k+1)，窗口 = 中心 ±0.5 ⇒ 最低档（k=4）中心 = baseDs+1.0
  const baseDs = thresholdBaseDs(thresholdRating)
  const baseDs10 = Math.round(baseDs * 10)
  const buckets = tiers.map((tier, k) => {
    const center = baseDs10 + TIER_DS_STEP * (k + 1)
    return { tier, lo: center - WINDOW_HALF, hi: center + WINDOW_HALF, rows: [] }
  })

  for (const song of totalList.root) {
    if (song.song_id >= UTAGE_SONG_ID) continue                      // 宴谱
    if (song.isnew) continue                                         // 新歌（当前版本池）
    for (const diff of song.difficulties) {
      if (!diff || !(diff.level_value > 0)) continue                 // 空难度位
      // 推荐度：缺统计（fit_diff/avg 非正数，多为新谱）无法排序，排除
      const stats = diff.stats
      const score = mode === 'avg'
        ? (stats?.avg > 0 ? stats.avg : null)
        : (stats?.fit_diff > 0 ? diff.level_value - stats.fit_diff : null)
      if (score == null) continue

      const rec = recordMap.get(`${song.song_id}-${diff.level_index}`)
      const ach = rec?.achievements ?? 0
      const dsInt = Math.round(diff.level_value * 10)
      for (const b of buckets) {
        if (ach >= b.tier) continue                                  // 已达该档 → 无推分空间
        if (dsInt < b.lo || dsInt >= b.hi) continue                  // 不在本档定数窗口

        b.rows.push({
          song_id: song.song_id,
          song_name: song.song_name,
          type: song.type,
          level_index: diff.level_index,
          level: diff.level,
          level_value: diff.level_value,
          achievements: rec ? rec.achievements : null,               // null = 未玩
          rate: rec?.rate ?? null,
          score,
        })
      }
    }
  }

  // 推荐度降序；平分时定数高者优先（同 Ra 增益下更值得推）、再按 id 升序保证稳定
  for (const b of buckets) {
    b.rows.sort((x, y) => y.score - x.score || y.level_value - x.level_value || x.song_id - y.song_id)
    b.rows = b.rows.slice(0, topN)
  }
  return { mode, thresholdRating, baseDs, tiers: buckets }
}
