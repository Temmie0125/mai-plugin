/**
 * 随心配变体的候选筛选（设计《b50扩展实现设计.md》§4.2）
 *
 * 「哪些成绩有资格进候选」在这里定，「怎么排名/截断」由 lib/b50Core.js 定（与拟合b50 共用）。
 * 纯函数、零 I/O、零网络——records 由调用方从缓存读出后传入，曲库经 deps 注入。
 *
 * 统一排除（设计 §0.2 V22/V23，与拟合b50 同口径）：
 * - 宴谱（song_id ≥ 100000）：真实 B50 本身不含宴谱；
 * - 曲库未收录的成绩：池归属（isnew）与筛选字段（genre/version/谱师）只能从曲库取。
 */
import { Best50 } from './merge/models.js'
import { SD_SLOTS, DX_SLOTS, UTAGE_SONG_ID, buildBest50, rankBest50 } from './b50Core.js'

/**
 * 曲库索引
 *
 * ⚠️ `MusicList.byId` 是 `Array.find`（O(曲数)），而全量成绩可达数千条 ⇒ 逐条 byId 是 O(n²)。
 * 有 `root` 就建一次 Map；测试注入的 `{ byId }` 桩则退化为直查（数据量小，无妨）。
 */
function makeIndex(totalList) {
  if (!totalList) return null
  if (Array.isArray(totalList.root)) {
    const m = new Map()
    for (const s of totalList.root) m.set(s.song_id, s)
    return m
  }
  return { get: id => totalList.byId?.(id) ?? null }
}

const emptyBest50 = () => Best50({})

/**
 * 变体的候选筛选与排名
 *
 * @param {Array} records PlayedResult[]（**真实**成绩，来自 records 缓存）
 * @param {object} spec 变体规格（lib/variantSpec.js 产出）
 * @param {{totalList: {byId?: Function, root?: Array}}} deps 曲库
 * @returns {{best50: {sd_total:number,dx_total:number,sd:Array,dx:Array}, total:number, candidates:number}}
 *   candidates = 通过筛选的谱面数；为 0 时调用方回「无符合条件的成绩」文案（歌50 另有一句）
 */
export function variantBest50(records, spec, deps = {}) {
  const list = records ?? []
  if (!spec) return { best50: emptyBest50(), total: 0, candidates: 0 }

  // 歌50：同一谱面重复填充两个池（V1）
  if (spec.mode === 'repeat') {
    const hits = list.filter(r => r.song_id === spec.songId && r.level_index === spec.levelIndex)
    if (!hits.length) return { best50: emptyBest50(), total: 0, candidates: 0 }
    // 同谱面同一难度只会有一条成绩；真有重复上传记录时取 rating 最高的一条
    const best = hits.reduce((a, b) => (b.rating > a.rating ? b : a))
    const sd = Array.from({ length: SD_SLOTS }, () => ({ ...best }))
    const dx = Array.from({ length: DX_SLOTS }, () => ({ ...best }))
    const { best50, total } = buildBest50(sd, dx)
    return { best50, total, candidates: 1 }
  }

  const index = makeIndex(deps.totalList)
  const entries = []
  for (const r of list) {
    if (r.song_id >= UTAGE_SONG_ID) continue                  // 宴谱（V23）
    const song = index?.get(r.song_id)
    if (!song) continue                                       // 曲库未收录（V22）
    if (!spec.match(r, song)) continue
    entries.push({ isnew: song.isnew, item: r })
  }

  const { best50, total } = rankBest50(entries)
  return { best50, total, candidates: entries.length }
}
