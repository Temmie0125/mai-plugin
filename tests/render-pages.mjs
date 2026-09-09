/**
 * P1 查询页渲染冒烟测试：真实曲库 fixture → 生产视图构建（views.js）→ 宿主 puppeteer screenshot → Buffer
 * 运行约定与 tests/render-help.mjs 一致（宿主渲染器 temp/renderers 路径相对 cwd）：
 *   cd E:/bot/Yunzai && node plugins/mai-plugin/tests/render-pages.mjs
 * 输出 plugins/mai-plugin/tests/out/*.jpg（逐个打开目检 + 与源 NoneBot 版同数据出图比对，设计 §12）
 *
 * 本脚本不触网：曲库走 §6.1 链路②（resources/static/data → data/music 一次性导入），
 * 玩家成绩为确定性伪随机 fixture（种子固定），rating 用 lib/calc.computeRating 真公式推算保证自洽。
 * fixture 明细落在 tests/out/fixtures.json，供源 NoneBot 侧参照图生成脚本（tests/refs/）读取同一数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// —— 宿主全局打桩（render-help.mjs 同款）——
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
const { computeRating, dxStar } = await import('../lib/calc.js')
const {
  b50View, playDataView, chartInfoView, chartInfoBanquetView, songListView, globalDataView,
} = await import('../lib/render/views.js')
const {
  renderBest50, renderPlayData, renderChartInfo, renderSongList, renderGlobalData,
} = await import('../lib/render/picmodle.js')

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out')
fs.mkdirSync(outDir, { recursive: true })

/** 确定性伪随机（mulberry32）——同一曲库 JSON 下出图可复现 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(20260909)

function pick(range) { return Math.floor(rng() * range) }
function pickOne(arr) { return arr[pick(arr.length)] }

/** 评级小写 key（源 RANK_SP 序） → 图标名映射即 constants.RANK_MAP，此处按达成率取 */
const ACH_BANDS = [
  [97.5, 98.2], [98.2, 99.0], [99.0, 99.4], [99.4, 99.9],
  [99.9, 100.4], [100.4, 100.9], [100.9, 101.3], [101.3, 101.9],
]

/** 生成一格成绩：真公式 rating、真 rate/fc/fs 键（key 均为 RANK_MAP/COMBO_MAP/SYNC_MAP 小写键） */
function makeRecord(song, li, { force = {} } = {}) {
  const dxMax = song.difficulties[li].dx_score
  const ds = song.difficulties[li].level_value
  const [lo, hi] = force.ach ? [force.ach, force.ach] : pickOne(ACH_BANDS)
  const achievements = force.ach ?? (lo + rng() * (hi - lo))
  const dxPct = 80 + rng() * 20.5
  const dxScore = Math.min(dxMax, Math.round(dxMax * dxPct / 100))
  const rate = computeRating(ds, achievements, { onlyrate: true }).toLowerCase()
  const rec = {
    song_id: song.song_id,
    level_index: li,
    level_value: ds,
    level: song.difficulties[li].level,
    type: song.song_id < 10000 ? 'sd' : 'dx',
    achievements,
    dx_score: dxScore,
    song_name: song.song_name,
    rate,
    rating: computeRating(ds, achievements),
  }
  if (force.fc) rec.fc = force.fc
  else if (rng() < 0.45) rec.fc = pickOne(['fc', 'fc', 'fc', 'fcp', 'ap', 'app'])
  // fs 键限源 FSType 合法集（fdx/fdxp 系 lxns 归一化前形态，合并层已转 fsd/fsdp）
  if (force.fs) rec.fs = force.fs
  else if (rng() < 0.3) rec.fs = pickOne(['fs', 'fs', 'fsp', 'fsd', 'fsdp'])
  if (force.songName) rec.song_name = force.songName
  return rec
}

/** 从合并曲库取 band 内歌曲（song_id 分带：SD <10000 / DX 10000~99999 / 宴 >=100000） */
function songsByBand(band) {
  const [lo, hi] = band
  return mai.totalList.root.filter(s => s.song_id >= lo && s.song_id < hi)
}

/** 每曲挑最高定数谱面 li；同曲不同谱去重 */
function bestChart(song) {
  let best = 0
  for (let i = 0; i < song.difficulties.length; i++) {
    if (song.difficulties[i].level_value > song.difficulties[best].level_value) best = i
  }
  return best
}

async function loadMusic() {
  await mai.init({ network: false })
  if (!mai.ready) {
    console.error('曲库未就绪：resources/static/data 缺少 merge_music_data.json 或复制失败')
    process.exit(1)
  }
}

/** 渲染单页并落盘；result 为 Buffer | Buffer[] | 错误文案 */
async function shot(name, result) {
  const list = Array.isArray(result) ? result : [result]
  const bufs = []
  for (const item of list) {
    if (!Buffer.isBuffer(item)) {
      console.error(`[fail] ${name} 渲染未返回 Buffer：`, String(item).slice(0, 200))
      return false
    }
    bufs.push(item)
  }
  const ext = 'jpg'
  const out = path.join(outDir, `${name}.${ext}`)
  fs.writeFileSync(out, Buffer.concat(bufs))
  const magic = bufs[0].subarray(0, 3).toString('hex')
  if (magic !== 'ffd8ff') {
    console.error(`[fail] ${name} 不是合法 JPEG（魔数 ${magic}）`)
    return false
  }
  const kb = (bufs.reduce((a, b) => a + b.length, 0) / 1024).toFixed(1)
  console.log(`[ok] ${name}.jpg ${kb}KB → ${out}`)
  return true
}

const results = {}

// =====================================================================
// fixture：B50（35 SD + 15 DX——真查询语义 B35/B15，画布网格 7 行 + 3 行；
//           源 whiledraw 行数无上限，1400×1600 恰好容纳 7+3，勿改小否则重现 5+5 中空 + DX 溢出）
// =====================================================================
function makeB50() {
  const sdCands = songsByBand([0, 10000])
  const dxCands = songsByBand([10000, 100000])
  const mkList = (cands, count) => {
    // 先乱序打散再取 count 首 → 覆盖不同版本/定数/曲绘
    for (let i = cands.length - 1; i > 0; i--) {
      const j = pick(i + 1); [cands[i], cands[j]] = [cands[j], cands[i]]
    }
    return cands.slice(0, count).map(song => makeRecord(song, bestChart(song)))
  }
  const sd = mkList(sdCands, 35).sort((a, b) => b.rating - a.rating)
  const dx = mkList(dxCands, 15).sort((a, b) => b.rating - a.rating)
  const sdTotal = sd.reduce((a, r) => a + r.rating, 0)
  const dxTotal = dx.reduce((a, r) => a + r.rating, 0)
  return {
    player: {
      name: '测试玩家',
      rating: sdTotal + dxTotal,
      course_rank: 9,
      class_rank: 14,
      trophy: null,
      icon: null,
      name_plate: null,
    },
    best50: { sd, dx, sd_total: sdTotal, dx_total: dxTotal },
  }
}

// =====================================================================
// main
// =====================================================================
await loadMusic()
const t0 = Date.now()

// -- 1. B50（prism_plus，无用户态 = 无 QQ 头像，走默认头像/名牌切图） --
const b50f = makeB50()
const vB50 = b50View({
  theme: 'prism_plus', qqid: null,
  player: b50f.player, best50: b50f.best50,
  serviceName: 'DivingFish', botName: 'MaiTest',
})
results.b50 = await shot('b50', await renderBest50(vB50))

// -- 2. 单曲成绩卡：找一首 4 难度（无 Re:Master）的歌，含 1 行未游玩 --
const sdSongs = songsByBand([0, 10000])
const s4 = sdSongs.find(s => s.difficulties.length === 4)
const rows4 = s4.difficulties.map((_, li) => (li === 2
  ? { notPlayed: true, level_value: s4.difficulties[li].level_value }
  : { notPlayed: false, ...makeRecord(s4, li) }))
const vScore = playDataView({
  theme: 'prism_plus', song: s4, playResult: rows4,
  serviceName: 'DivingFish', botName: 'MaiTest',
})
results.score = await shot('score', await renderPlayData(vScore))

// -- 3a. 谱面信息卡：5 难度带 Re:Master，无用户（calc=false） --
const s5 = sdSongs.find(s => s.difficulties.length === 5)
const vSong = chartInfoView({ song: s5, calc: false, botName: 'MaiTest' })
results.song = await shot('song', await renderChartInfo(vSong))

// -- 3b. 谱面信息卡：calc=true 且 B50 满 → 打最高配置算 ↑ 涨幅 --
const s5b = sdSongs.find(s => s !== s5 && s.difficulties.length === 5)
const fakeList = []
for (let i = 0; i < 35; i++) fakeList.push({ song_id: 1, level_index: 3, rating: 12000 + i })
const vSongFull = chartInfoView({
  song: s5b, calc: true, isFull: true, bestList: fakeList, botName: 'MaiTest',
})
results['song-full'] = await shot('song-full', await renderChartInfo(vSongFull))

// -- 3c. 宴谱信息卡（id≥100000，未主题化背景）——
const utage = songsByBand([100000, 1000000])
const ut1 = utage.find(s => !s.is_buddy) ?? utage[0]
const ut2 = utage.find(s => s.is_buddy) ?? ut1
results['song-utage'] = await shot('song-utage', await renderChartInfo(chartInfoBanquetView({ song: ut1, botName: 'MaiTest' })))
results['song-utage-buddy'] = await shot('song-utage-buddy', await renderChartInfo(chartInfoBanquetView({ song: ut2, botName: 'MaiTest' })))

// -- 4. 曲目列表：Master 定数 ≥14 全家福取前 14（1 页满行 + 跨版本密度）--
const lv14 = mai.totalList.root
  .filter(s => s.song_id < 100000 && s.difficulties.some(d => d.level_value >= 14))
  .slice(0, 14)
const vList = songListView({ songs: lv14, page: 1, totalPage: 2, botName: 'MaiTest' })
results.songlist = await shot('songlist', await renderSongList(vList))

// -- 5. 全服统计饼图（ECharts 内联，取一首有谱面统计的 Master 谱）--
const gSong = mai.totalList.root.find(s => s.difficulties[3]?.stats?.fc_dist?.length >= 4)
const vGlobal = globalDataView({ song: gSong, levelIndex: 3 })
results.global = await shot('global', await renderGlobalData(vGlobal))

// fixture 明细落盘（供 NoneBot 侧参照图脚本）
fs.writeFileSync(path.join(outDir, 'fixtures.json'), JSON.stringify({
  b50: b50f,
  score: { song_id: s4.song_id, rows: rows4 },
  song: { song_id: s5.song_id },
  songFull: { song_id: s5b.song_id, calc: true, isFull: true, bestListLen: fakeList.length, bestLastRating: fakeList[34].rating },
  songUtage: { song_id: ut1.song_id },
  songUtageBuddy: { song_id: ut2.song_id },
  songlist: { ids: lv14.map(s => s.song_id) },
  global: { song_id: gSong.song_id, levelIndex: 3 },
}, null, 2))
console.log(`[ok] fixtures.json → ${path.join(outDir, 'fixtures.json')}`)

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name)
const all = Object.keys(results).length
console.log(`\n渲染冒烟：${all - failed.length}/${all} 页通过 · ${Date.now() - t0}ms`)
if (failed.length) {
  console.error('失败页：', failed.join(', '))
  process.exit(1)
}
process.exit(0) // 宿主渲染器 watcher 保持事件循环，主动退出
