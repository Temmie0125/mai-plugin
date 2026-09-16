/**
 * 随心配变体渲染冒烟：真实曲库 fixture → variantBest50 → b50View（变体模式）→ 宿主 screenshot
 *
 * 运行约定与 tests/render-pages.mjs 一致（宿主渲染器 temp/renderers 路径相对 cwd）：
 *   cd E:/bot/Yunzai && node plugins/mai-plugin/tests/render-variantb50.mjs
 * 输出 plugins/mai-plugin/tests/out/variant-*.jpg / varianthelp.jpg / plate-dajiang.jpg（逐个目检）
 *
 * ⚠️ 本脚本**直接调 b50View / variantBest50，不经 handler**：冒烟族不注入 scoreCache.setDataRoot，
 *    走 handler 会写真机 data/score/（《拟合b50实现设计》§3.1 的纪律）。
 * 目检要点：① 变体名横幅是否压到称号框或成绩格；② 称号框合计行是否被挤出框；
 *          ③ 两个主题、长标签（其他游戏/はっぴー）、稀疏结果（AP 只有几条）各看一张。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// —— 宿主全局打桩（render-pages.mjs 同款）——
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
const { computeRating } = await import('../lib/calc.js')
const { b50View } = await import('../lib/render/views.js')
const { renderBest50, renderVariantHelp, renderPanel } = await import('../lib/render/picmodle.js')
const { plateTableView } = await import('../lib/render/tableViews.js')
const { processPlateTable } = await import('../lib/tableData.js')
const { variantBest50 } = await import('../lib/variantB50.js')
const { AP_SPEC, resolveVariant, repeatSpec } = await import('../lib/variantSpec.js')
const { defaultLevelIndex, simRecord, splitSimTokens } = await import('../lib/simScore.js')
const { VERSION_MAP } = await import('../lib/constants.js')

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out')
fs.mkdirSync(outDir, { recursive: true })

/** 确定性伪随机（同 render-pages.mjs，出图可复现） */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(20260915)
const pick = n => Math.floor(rng() * n)

async function loadMusic() {
  await mai.init({ network: false })
  if (!mai.ready) {
    console.error('曲库未就绪：resources/static/data 缺少 merge_music_data.json 或复制失败')
    process.exit(1)
  }
}

async function shot(name, result) {
  if (!Buffer.isBuffer(result)) {
    console.error(`[fail] ${name} 渲染未返回 Buffer：`, String(result).slice(0, 200))
    return false
  }
  const out = path.join(outDir, `${name}.jpg`)
  fs.writeFileSync(out, result)
  const magic = result.subarray(0, 3).toString('hex')
  if (magic !== 'ffd8ff') {
    console.error(`[fail] ${name} 不是合法 JPEG（魔数 ${magic}）`)
    return false
  }
  console.log(`[ok] ${name}.jpg ${(result.length / 1024).toFixed(1)}KB → ${out}`)
  return true
}

/** 每曲挑最高定数谱面 */
function bestChart(song) {
  let best = 0
  for (let i = 0; i < song.difficulties.length; i++) {
    if (song.difficulties[i].level_value > song.difficulties[best].level_value) best = i
  }
  return best
}

const SONGS = () => mai.totalList.root.filter(s => s.song_id < 100000)

/** 打散后取 n 首 */
function sample(n, filter = () => true) {
  const cands = SONGS().filter(filter)
  for (let i = cands.length - 1; i > 0; i--) {
    const j = pick(i + 1); [cands[i], cands[j]] = [cands[j], cands[i]]
  }
  return cands.slice(0, n)
}

/** 造一条成绩（rating 用真公式，保证图文自洽） */
function rec(song, li, { ach, fc = null, fs = null }) {
  const ds = song.difficulties[li].level_value
  return {
    song_id: song.song_id,
    song_name: song.song_name,
    level: song.difficulties[li].level,
    level_index: li,
    level_value: ds,
    type: song.type,
    achievements: ach,
    rating: computeRating(ds, ach),
    rate: computeRating(ds, ach, { onlyrate: true }).toLowerCase(),
    fc,
    fs,
    dx_score: Math.round(song.difficulties[li].dx_score * (0.9 + rng() * 0.1)),
  }
}

const PLAYER = {
  name: '测试玩家',
  rating: 15234,
  course_rank: 9,
  class_rank: 14,
  trophy: { id: 1, name: 'れっつゴー！', color: 'Rainbow' },
  icon: null,
  name_plate: null,
}

/** 变体出图（视图 → 渲染；labelTail 见 b50View 的 variantLabelTail） */
async function shotVariant(name, { records, spec, theme = 'prism_plus', label, labelTail = null }) {
  const { best50, total, candidates } = variantBest50(records, spec, { totalList: mai.totalList })
  console.log(`  · ${name}: candidates=${candidates} B35=${best50.sd.length} B15=${best50.dx.length} total=${total}`)
  const view = b50View({
    theme, qqid: null, player: { ...PLAYER, rating: total }, best50,
    variantLabel: label ?? spec.label, variantLabelTail: labelTail,
    serviceName: 'Diving-Fish', botName: 'MaiTest',
  })
  return await shot(name, await renderBest50(view))
}

await loadMusic()

// =====================================================================
// fixture：35 旧版 + 15 新版，fc/fs 按需分布（覆盖 FC/单刷/拼机/AP/nb 各类）
// =====================================================================
const sdSongs = sample(35, s => !s.isnew)
const dxSongs = sample(15, s => s.isnew)
const records = []
for (const s of [...sdSongs, ...dxSongs]) {
  const li = bestChart(s)
  const ach = 98 + rng() * 3            // 98~101：覆盖 SSS/SSS+/理论 与「寸/锁」边缘
  // fs：拼机标识（sync/fs/fsd）与单刷交替；fc：fc/fcp/ap/app 四态
  const fsRoll = pick(4)
  const fs = [null, 'sync', 'fs', 'fsd'][fsRoll]
  const fc = ['fc', 'fcp', 'ap', 'app'][pick(4)]
  records.push(rec(s, li, { ach, fc, fs }))
}

// —— AP（水鱼 AP50 口径）：把其中一批改成 AP ——
const apRecords = records.map((r, i) => (i % 3 === 0 ? { ...r, fc: i % 2 ? 'ap' : 'app' } : r))

const results = {}
console.log('渲染中…')
results['variant-fc'] = await shotVariant('variant-fc', { records, spec: resolveVariant('FC') })
results['variant-multi'] = await shotVariant('variant-multi', { records, spec: resolveVariant('拼机') })
results['variant-solo'] = await shotVariant('variant-solo', { records, spec: resolveVariant('单刷'), theme: 'circle' })
results['variant-othergame'] = await shotVariant('variant-othergame', {
  records, spec: resolveVariant('其他游戏'), label: '其他游戏',   // 长标签：验横幅宽度
})
results['variant-cun'] = await shotVariant('variant-cun', { records, spec: resolveVariant('寸'), label: '寸' })
results['variant-ap'] = await shotVariant('variant-ap', { records: apRecords, spec: AP_SPEC, label: 'AP' })

// 歌50：一首曲重复填充 35+15
const song50Song = sdSongs[0]
const song50Rec = records.find(r => r.song_id === song50Song.song_id)
results['variant-song50'] = await shotVariant('variant-song50', {
  records,
  spec: repeatSpec({ song_id: song50Song.song_id, level_index: song50Rec.level_index },
    `歌50 · ${song50Song.song_name}`),
})

// 歌50 模拟（lib/simScore.js）：合成成绩填池，**records 传空数组**（模拟路径不读成绩）。
// 刻意挑曲库里最长的曲名 —— 横幅要放「歌50 · <曲名> · 模拟 101.0000% FDX+ 5★ AP+」，
// 这是全页最长的一条文案，用它验 R2（横幅不压称号框与成绩格）。
const simSong = SONGS().reduce((a, b) => (b.song_name.length > a.song_name.length ? b : a))
const simLi = defaultLevelIndex(simSong)
const simSpec = splitSimTokens('理论 FDX+ 5星 AP+')
const built = simRecord({
  song: simSong,
  levelIndex: simLi,
  levelValue: simSong.difficulties[simLi].level_value,
  dxMax: simSong.difficulties[simLi].dx_score,
  sim: simSpec.sim,
})
if (built.error) throw new Error(`模拟成绩构造失败：${JSON.stringify(built.error)}`)
results['variant-song50-sim'] = await shotVariant('variant-song50-sim', {
  records: [],
  label: `歌50 · ${simSong.song_name}`,
  labelTail: `· 模拟 ${built.summary}`,   // 与 handler.drawSong50 一致：尾段不可被截断
  spec: repeatSpec({ song_id: simSong.song_id, level_index: simLi },
    `歌50 · ${simSong.song_name}`, built.record),
})

// =====================================================================
// 随心配专题帮助图
// =====================================================================
results.varianthelp = await shot('varianthelp', await renderVariantHelp('mai', 'v0.1.0'))

// =====================================================================
// 大将表（版本 堇 → PLATE_CN 归一为 菫，牌图 菫将.png 在场；V19 复用将图）
// =====================================================================
{
  const [versionName, verShort] = [VERSION_MAP['菫'][1], '菫']
  const plateIds = mai.totalPlateIdList[versionName] ?? []
  const verseSongs = mai.totalList.byIdList(plateIds)
  const platePlay = []
  verseSongs.forEach((s, i) => {
    // 前 10 首四难度全达标（图上应显示「整曲完成」），其余每首只打最高难度（部分达标）
    const slots = i < 10 ? [0, 1, 2, 3] : [3]
    for (const li of slots) {
      platePlay.push(rec(s, li, { ach: i < 10 || pick(2) ? 100.5 + rng() * 0.4 : 99 + rng() * 1.4 }))
    }
  })
  const data = processPlateTable({
    version: verShort, versionName, isWu: false, page: 1, plan: '大将', playResult: platePlay,
    plateIdList: mai.totalPlateIdList, totalList: mai.totalList,
  })
  console.log(`  · 大将(${verShort}): 达标 ${data.completedCount}/${data.totalCount}（曲 ${verseSongs.length}）`)
  results['plate-dajiang'] = await shot('plate-dajiang', await renderPanel('plate-dajiang', plateTableView({
    version: verShort, isWu: false, page: 1, plan: '大将', data, botName: 'MaiTest',
  })))
}

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([k]) => k)
const all = Object.keys(results).length
console.log(`\n渲染冒烟：${all - failed.length}/${all} 页通过`)
if (failed.length) {
  console.error('失败页：', failed.join(', '))
  process.exit(1)
}
process.exit(0) // 宿主渲染器 watcher 保持事件循环，主动退出
