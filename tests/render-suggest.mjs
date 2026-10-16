/**
 * 推分建议页渲染冒烟：真实曲库 fixture → buildSuggestList → suggestView → 宿主 puppeteer 出图
 * 运行约定与 tests/render-pages.mjs 一致（宿主渲染器 temp/renderers 路径相对 cwd）：
 *   cd E:/bot/Yunzai && node plugins/mai-plugin/tests/render-suggest.mjs
 * 输出 plugins/mai-plugin/tests/out/suggest*.jpg（目检版式：五档块头/行/空档/页脚）
 *
 * 本脚本不触网：曲库走 resources/static/data → data/music 一次性导入；
 * 成绩为确定式 fixture（按五档分带铺达成率，并混入已鸟加与未玩形态）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(target, prop) {
      if (prop in console) return console[prop].bind(console)
      return (...args) => args.join(' ')
    },
  })
}
if (!global.segment) {
  global.segment = { image: buf => ({ type: 'image', buffer: buf }) }
}
if (!global.redis) {
  const mem = new Map()
  global.redis = {
    async set(k, v) { mem.set(k, v); return 'OK' },
    async get(k) { return mem.get(k) ?? null },
    async del(...keys) { let n = 0; for (const k of keys) { mem.delete(k); n++ } return n },
  }
}

const { mai } = await import('../lib/service.js')
const { buildSuggestList, thresholdBaseDs } = await import('../lib/suggest.js')
const { suggestView } = await import('../lib/render/views.js')
const { renderSuggest } = await import('../lib/render/picmodle.js')
const { computeRating } = await import('../lib/calc.js')

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out')
fs.mkdirSync(outDir, { recursive: true })

await mai.init({ network: false })
if (!mai.ready) {
  console.error('曲库未就绪：resources/static/data 缺少 merge_music_data.json')
  process.exit(1)
}

/** 当前 Rating 12500 → 默认阈值 13000（baseDs 11.6，五档窗口覆盖 [11.3, 13.1)） */
const RATING = 12500
const threshold = (Math.floor(RATING / 500) + 1) * 500
const baseDs = thresholdBaseDs(threshold)
const loDs = baseDs - 0.3
const hiDs = baseDs + 1.7
console.log('  · 阈值:', threshold, '· baseDs:', baseDs, '· 窗口联合覆盖:', loDs, '~', hiDs)

/** 区间内按难度取候选（排除新歌/宴谱，与算法口径一致），按序循环铺达成率形态 + 已鸟加 + 留空（未玩） */
const BANDS = [100.2, 99.8, 99.2, 98.7, 97.0, 100.5, null]
function makeRecords() {
  const cands = []
  for (const s of mai.totalList.root) {
    if (s.song_id >= 100000 || s.isnew) continue
    for (const d of s.difficulties) {
      if (d && d.level_value >= loDs && d.level_value < hiDs) cands.push([s, d])
    }
  }
  cands.sort((a, b) => a[0].song_id - b[0].song_id || a[1].level_index - b[1].level_index)
  const out = []
  cands.forEach(([s, d], i) => {
    const ach = BANDS[i % BANDS.length]
    if (ach == null) return                       // 留作「未玩」
    out.push({
      song_id: s.song_id, level_index: d.level_index, level_value: d.level_value, level: d.level,
      type: s.song_id < 10000 ? 'sd' : 'dx', achievements: ach, dx_score: 0,
      song_name: s.song_name,
      rate: computeRating(d.level_value, ach, { onlyrate: true }).toLowerCase(),
      rating: computeRating(d.level_value, ach),
    })
  })
  console.log(`  · 候选谱面 ${cands.length}，生成成绩 ${out.length} 条`)
  return out
}

const records = makeRecords()

async function shot(name, result) {
  if (!Buffer.isBuffer(result)) {
    console.error(`[fail] ${name} 渲染未返回 Buffer：`, String(result).slice(0, 200))
    return false
  }
  const out = path.join(outDir, `${name}.jpg`)
  fs.writeFileSync(out, result)
  const kb = (result.length / 1024).toFixed(1)
  console.log(`[ok] ${name}.jpg ${kb}KB → ${out}`)
  return true
}

for (const mode of ['diff', 'avg']) {
  const built = buildSuggestList({ totalList: mai.totalList, records, mode, thresholdRating: threshold })
  const filled = built.tiers.map(t => `${t.tier}:${t.lo / 10}~${(t.hi - 1) / 10}(${t.rows.length})`).join(' ')
  console.log(`  · mode=${mode} 各档窗口(条数): ${filled}`)
  const view = suggestView({
    tiers: built.tiers, mode, currentRating: RATING, thresholdRating: threshold,
    serviceName: 'Diving-Fish', botName: 'MaiTest',
  })
  if (!await shot(`suggest-${mode}`, await renderSuggest(view))) process.exit(1)
}
process.exit(0)
