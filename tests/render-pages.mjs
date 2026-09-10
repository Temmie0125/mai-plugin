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
  renderBest50, renderPlayData, renderChartInfo, renderSongList, renderGlobalData, renderPanel,
} = await import('../lib/render/picmodle.js')
const { ratingTableView, plateTableView } = await import('../lib/render/tableViews.js')
const { plateProgressView, levelPlanView, levelCategoryView, levelScoreListView } = await import('../lib/render/scoreViews.js')
const { processRatingTableData, processPlateTable, processLevelProgress, processLevelScoreList } = await import('../lib/tableData.js')
const { levelPlanHeights, levelScoreListLayout } = await import('../lib/tableLayout.js')
const { getRiseScoreList } = await import('../lib/tableData.js')
const { riseView } = await import('../lib/render/scoreViews.js')
const { VERSION_MAP } = await import('../lib/constants.js')

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
  serviceName: 'Diving-Fish', botName: 'MaiTest',
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
  serviceName: 'Diving-Fish', botName: 'MaiTest',
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

// -- 6. 定数表（ADR-7：底图由本插件按源 update_table.py 坐标重画，不读预生成 PNG）--
// 取定数组最多的标签，覆盖多组/多行；15 另走大格布局且**必然带占位格**（当前数据仅 2 首）
const busiestLevel = Object.entries(mai.totalLevelData)
  .map(([lv, bucket]) => [lv, Object.values(bucket).reduce((a, b) => a + b.length, 0)])
  .sort((a, b) => b[1] - a[1])[0][0]
const vTable = ratingTableView({
  rating: busiestLevel, levelData: mai.totalLevelData[busiestLevel], levelText: true, botName: 'MaiTest',
})
results.table = await shot('table', await renderPanel('table', vTable))

const vTable15 = ratingTableView({
  rating: '15', levelData: mai.totalLevelData['15'], levelText: true, botName: 'MaiTest',
})
results.table15 = await shot('table-15', await renderPanel('table-15', vTable15))

// -- 7. 定数完成表（整图 ×0.8；覆盖 complete_1/unfinished_1、评级图标、FC 图标、全清徽章）--
// 成绩完全确定式生成（不依赖 rng 调用序），两侧同表同值
function makeTableRecord(simple, { ach, fc = null, fs = null }) {
  const diff = simple.difficulties
  const dxMax = diff.dx_score ?? 0
  return {
    song_id: simple.song_id,
    level_index: diff.level_index,
    level_value: diff.level_value,
    level: diff.level,
    type: simple.song_id < 10000 ? 'sd' : 'dx',
    achievements: ach,
    dx_score: Math.round((dxMax * (80 + (simple.song_id % 200) / 10)) / 100),
    song_name: mai.totalList.byId(simple.song_id)?.song_name ?? String(simple.song_id),
    rate: computeRating(diff.level_value, ach, { onlyrate: true }).toLowerCase(),
    rating: computeRating(diff.level_value, ach),
    fc,
    fs,
  }
}
const lv13Songs = Object.values(mai.totalLevelData['13']).flat()
const achOf = (i) => 96 + ((i * 7) % 50) / 10 // 96.0～100.9，混出 <100 与 ≥100

// ① 部分游玩：每 6 首留 1 首未游玩 → 同时出现 complete_1 与 unfinished_1
const plateRows = lv13Songs.filter((_, i) => i % 6 !== 5)
  .map((s, i) => makeTableRecord(s, {
    ach: achOf(i), fc: i % 3 === 0 ? 'fc' : (i % 3 === 1 ? 'ap' : null), fs: i % 4 === 0 ? 'fsd' : null,
  }))
// ② 全清（RANK 路）：全谱面 ≥100.5 → 触发 Allclear 徽章 SSSp
const plateFullRows = lv13Songs.map((s, i) => makeTableRecord(s, {
  ach: 100.5, fc: i % 2 === 0 ? 'app' : null, fs: i % 3 === 0 ? 'fsdp' : null,
}))
// ③ fc 计划（COMBO 路）：全谱面 ap → 触发 50×50 FC 图标与 Allclear AP 徽章
const plateFcRows = lv13Songs.map(s => makeTableRecord(s, { ach: 100.5, fc: 'ap' }))

function plateFixture(rows, plan) {
  const { statistics, playedMap } = processRatingTableData('13', rows)
  return ratingTableView({
    rating: '13', levelData: mai.totalLevelData['13'], plan, statistics, playedMap, botName: 'MaiTest',
  })
}
results.plate = await shot('plate', await renderPanel('plate', plateFixture(plateRows, false)))
results['plate-full'] = await shot('plate-full', await renderPanel('plate-full', plateFixture(plateFullRows, false)))
results['plate-fc'] = await shot('plate-fc', await renderPanel('plate-fc', plateFixture(plateFcRows, true)))

// -- 8. 版本称号完成表（含舞/霸的两页与 5 槽位白谱点）--
// 成绩按「曲 id + 槽位」确定式生成，两侧共用同一份行，避免各自推导漂移
function plateRecords(ids, plan) {
  const remasterIdSet = new Set(mai.totalPlateIdList['舞ReMASTER'] ?? [])
  const out = []
  ids.forEach((sid, i) => {
    const song = mai.totalList.byId(sid)
    if (!song) return
    const slots = remasterIdSet.has(sid) && song.difficulties[4] ? 5 : 4
    for (let li = 0; li < Math.min(slots, song.difficulties.length); li++) {
      const d = song.difficulties[li]
      const ach = plan === '将' || plan === '者' ? (i % 5 === 0 ? 99.5 : 100.5) : 100.5
      out.push({
        song_id: sid, level_index: li, level_value: d.level_value, level: d.level,
        type: sid < 10000 ? 'sd' : 'dx', achievements: ach, dx_score: 0,
        song_name: song.song_name,
        rate: computeRating(d.level_value, ach, { onlyrate: true }).toLowerCase(),
        rating: computeRating(d.level_value, ach),
        // 极/神 看 fc，舞舞 看 fs；其余留 null
        fc: (plan === '极' || plan === '神') ? ['ap', 'fc', 'fcp', null][i % 4] : null,
        fs: plan === '舞舞' ? (i % 3 === 0 ? 'fsd' : null) : null,
      })
    }
  })
  return out
}

function plateTableFixture(version, plan, page) {
  const [versionList, versionName] = VERSION_MAP[version]
  const isWu = version === '舞' || version === '霸'
  const ids = isWu ? mai.totalPlateIdList['舞'] : mai.totalPlateIdList[versionName]
  const playResult = plateRecords(ids, plan)
  const data = processPlateTable({
    version, versionName, isWu, page, plan, playResult,
    plateIdList: mai.totalPlateIdList, totalList: mai.totalList,
  })
  const remasterIdSet = isWu ? new Set(mai.totalPlateIdList['舞ReMASTER'] ?? []) : null
  return {
    view: plateTableView({ version, isWu, page, plan, data, remasterIdSet, botName: 'MaiTest' }),
    rows: playResult,
  }
}

const fxZhenji = plateTableFixture('真', '极', 1)
results.plateZhenji = await shot('plate-zhenji', await renderPanel('plate-zhenji', fxZhenji.view))
const fxWu1 = plateTableFixture('舞', '将', 1)
results.plateWu1 = await shot('plate-wu1', await renderPanel('plate-wu1', fxWu1.view))
const fxWu2 = plateTableFixture('舞', '将', 2)
results.plateWu2 = await shot('plate-wu2', await renderPanel('plate-wu2', fxWu2.view))

// -- 9. 牌子进度（每难度未完成清单；舞将的 Master 未完成 >51 → 触发「余 N 个未完成」中断分支）--
function plateProgressFixture(version, plan) {
  const [, versionName] = VERSION_MAP[version]
  const isWu = version === '舞' || version === '霸'
  const ids = isWu ? mai.totalPlateIdList['舞'] : mai.totalPlateIdList[versionName]
  const rows = plateRecords(ids, plan)
  const data = processPlateTable({
    version, versionName, isWu, page: 1, plan, playResult: rows,
    plateIdList: mai.totalPlateIdList, totalList: mai.totalList,
  })
  return { view: plateProgressView({ version, isWu, plan, data, botName: 'MaiTest' }), rows }
}
const fxProgZhen = plateProgressFixture('真', '极')
results.plateProgressZhen = await shot('plateprogress-zhenji',
  await renderPanel('plateprogress-zhenji', fxProgZhen.view))
const fxProgWu = plateProgressFixture('舞', '将')
results.plateProgressWu = await shot('plateprogress-wu',
  await renderPanel('plateprogress-wu', fxProgWu.view))

// -- 10. 等级进度（三段版 / 单类别版）与分数列表 --
// 成绩：每 5 首留 1 首未游玩；fc 按 5 循环混出 ap/app（达成）/ fc/fcp（未达成）/ null
const progressRows = lv13Songs
  .filter((_, i) => i % 5 !== 4)
  .map((s, i) => makeTableRecord(s, { ach: 99 + (i % 12) / 10, fc: ['ap', 'app', 'fc', 'fcp', null][i % 5] }))

function progressFixture(level, plan, category, page = 1) {
  const { completed, unfinished, notplayed } = processLevelProgress({
    level, plan, playResult: progressRows, byPlan: mai.totalList.byPlan(level),
  })
  const heights = levelPlanHeights({ category, completed, unfinished, notplayed, page })
  const common = { serviceName: 'Diving-Fish', botName: 'MaiTest' }
  const view = heights.mode === 'plan'
    ? levelPlanView({ level, plan, completed, unfinished, notplayed, heights, cmdHead: 'mai', ...common })
    : levelCategoryView({
      category,
      data: heights.mode === 'notplayed' ? notplayed : (category === 'completed' ? completed : unfinished),
      heights,
      ...common,
    })
  return { view, rows: progressRows, counts: { completed: completed.length, unfinished: unfinished.length, notplayed: notplayed.length } }
}

const fxProg = progressFixture('13', 'ap', 'default')
console.log('  · 等级进度 13/ap 三段计数:', JSON.stringify(fxProg.counts), ' 高度', fxProg.view.height)
results.progress = await shot('progress', await renderPanel('progress', fxProg.view))

const fxProgUnfinished = progressFixture('13', 'ap', 'unfinished')
results.progressUnfinished = await shot('progress-unfinished', await renderPanel('progress-unfinished', fxProgUnfinished.view))

const fxProgNotplayed = progressFixture('13', 'ap', 'notplayed')
results.progressNotplayed = await shot('progress-notplayed', await renderPanel('progress-notplayed', fxProgNotplayed.view))

// 分数列表：100 条 → 非末页与末页两条公式都要走到，故出两页
const scoreListRows = processLevelScoreList({ rating: '13', playResult: progressRows })
const fxList = (page) => {
  const lay = levelScoreListLayout(scoreListRows.length, page)
  return levelScoreListView({
    rating: '13', playResult: scoreListRows, page: lay.page, endPage: lay.endPage,
    serviceName: 'Diving-Fish', botName: 'MaiTest',
  })
}
console.log('  · 分数列表 13：共', scoreListRows.length, '条 →', levelScoreListLayout(scoreListRows.length, 1).endPage, '页')
results.scorelist = await shot('scorelist', await renderPanel('scorelist', fxList(1)))
results.scorelistLast = await shot('scorelist-last',
  await renderPanel('scorelist-last', fxList(levelScoreListLayout(scoreListRows.length, 1).endPage)))

// -- 11. 上分推荐（旧/新版本两列；crop((200,0,1200,960)) → 1000×960）--
// ⚠️ 源的 `random.sample` 使抽样不确定 → 两侧出图不同。此处注入**确定性采样器**，
// 参照侧 make_refs.py 把 `random.sample` 打成同一规则，于是比对校验的是算法与版式，
// 抽样本身由 tests/rise.test.js 单测覆盖。
const risePlayResult = lv13Songs
  .filter((_, i) => i % 3 === 0)
  .map((s, i) => makeTableRecord(s, { ach: 98 + (i % 10) / 10, fc: 'fc', fs: 'fs' }))
const riseShuffled = [...risePlayResult].sort((a, b) => b.rating - a.rating)
const riseB50 = {
  sd: riseShuffled.filter(r => r.song_id < 10000).slice(0, 25),
  dx: riseShuffled.filter(r => r.song_id >= 10000).slice(0, 15),
}
const detSample = (arr, k) => arr.slice(0, k)

function riseFixture(level, score) {
  const oldRecords = new Map(risePlayResult.map(v => [`${v.song_id}-${v.level_index}`, v]))
  const deps = { totalList: mai.totalList, sample: detSample }
  const sd = getRiseScoreList(oldRecords, 'sd', riseB50.sd, level, score, deps)
  const dx = getRiseScoreList(oldRecords, 'dx', riseB50.dx, level, score, deps)
  console.log(`  · 上分推荐 level=${level} score=${score}: sd ${sd.list.length} 条(ds ${sd.list.map(r => r.level_value).join('/')}) · dx ${dx.list.length} 条`)
  return {
    view: riseView({
      sd: sd.list, sdLow: sd.lowestRa, dx: dx.list, dxLow: dx.lowestRa,
      serviceName: 'Diving-Fish', botName: 'MaiTest',
    }),
    sd, dx,
  }
}
const fxRise = riseFixture('13', 10)
results.rise = await shot('rise', await renderPanel('rise', fxRise.view))

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
  table: { rating: busiestLevel },
  table15: { rating: '15' },
  // 完成表三态：两侧共用同一份确定性成绩行（避免各自推导产生顺序漂移）
  plate: { rating: '13', plan: false, rows: plateRows },
  plateFull: { rating: '13', plan: false, rows: plateFullRows },
  plateFc: { rating: '13', plan: true, rows: plateFcRows },
  plateZhenji: { version: '真', plan: '极', page: 1, rows: fxZhenji.rows },
  plateWu1: { version: '舞', plan: '将', page: 1, rows: fxWu1.rows },
  plateWu2: { version: '舞', plan: '将', page: 2, rows: fxWu2.rows },
  plateProgressZhen: { version: '真', plan: '极', rows: fxProgZhen.rows },
  plateProgressWu: { version: '舞', plan: '将', rows: fxProgWu.rows },
  progress: { level: '13', plan: 'ap', category: 'default', page: 1, rows: fxProg.rows },
  progressUnfinished: { level: '13', plan: 'ap', category: 'unfinished', page: 1, rows: fxProgUnfinished.rows },
  progressNotplayed: { level: '13', plan: 'ap', category: 'notplayed', page: 1, rows: fxProgNotplayed.rows },
  scorelist: { rating: '13', page: 1, rows: scoreListRows },
  scorelistLast: { rating: '13', page: levelScoreListLayout(scoreListRows.length, 1).endPage, rows: scoreListRows },
  rise: {
    level: '13', score: 10,
    playResult: risePlayResult,
    best50: { sd: riseB50.sd, dx: riseB50.dx, sd_total: 0, dx_total: 0 },
  },
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
