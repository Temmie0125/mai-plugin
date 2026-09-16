/**
 * 收藏品切图（icon 头像 / plate 姓名框）本地优先链路渲染冒烟
 *
 * 运行约定与 tests/render-pages.mjs 一致（宿主渲染器 temp/renderers 路径相对 cwd）：
 *   cd E:/bot/Yunzai && node plugins/mai-plugin/tests/render-iconplate.mjs
 * 输出 plugins/mai-plugin/tests/out/iconplate-*.jpg（逐个目检）
 *
 * 三页覆盖三条分支（脚本自行回读视图对象里被 ensureLocalAssets 改写后的 src 作佐证）：
 *   iconplate-local       资源包有该 id → file://（零网络）
 *   iconplate-online      资源包无该 id → 先在线取、落盘 data/assets/<sha1>，src 变 file://
 *                         （**需联网**；离线时 src 保留在线 URL，由模板 onerror 回退默认图）
 *   iconplate-off         同上但 assetsOnline=false（仅改内存配置副本，不落盘）→ 直接默认图
 *
 * ⚠️ 与 render-pages.mjs 同纪律：直接调 b50View + renderBest50，不经 handler（不写 data/score/）。
 * 目检要点：① 本地 webp 与在线切图的裁切/比例是否一致（牌 800×130 / 头像 120×120 是拉伸框）；
 *          ② 缺图两页是否落在「默认牌 + 默认头像」而不是空白或半图。
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
const { renderBest50 } = await import('../lib/render/picmodle.js')
const Config = (await import('../lib/config.js')).default
const { staticRoot } = await import('../lib/path.js')

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
const rng = mulberry32(20260916)
const pick = n => Math.floor(rng() * n)
const pickOne = arr => arr[pick(arr.length)]

const ACH_BANDS = [
  [97.5, 98.2], [98.2, 99.0], [99.0, 99.4], [99.4, 99.9],
  [99.9, 100.4], [100.4, 100.9], [100.9, 101.3], [101.3, 101.9],
]

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
  if (result.subarray(0, 3).toString('hex') !== 'ffd8ff') {
    console.error(`[fail] ${name} 不是合法 JPEG`)
    return false
  }
  console.log(`[ok] ${name}.jpg ${(result.length / 1024).toFixed(1)}KB → ${out}`)
  return true
}

function bestChart(song) {
  let best = 0
  for (let i = 0; i < song.difficulties.length; i++) {
    if (song.difficulties[i].level_value > song.difficulties[best].level_value) best = i
  }
  return best
}

/** 生成一格成绩（真公式 rating，图文自洽） */
function makeRecord(song, li) {
  const ds = song.difficulties[li].level_value
  const [lo, hi] = pickOne(ACH_BANDS)
  const achievements = lo + rng() * (hi - lo)
  return {
    song_id: song.song_id,
    level_index: li,
    level_value: ds,
    level: song.difficulties[li].level,
    type: song.song_id < 10000 ? 'sd' : 'dx',
    achievements,
    dx_score: Math.round(song.difficulties[li].dx_score * (0.8 + rng() * 0.2)),
    song_name: song.song_name,
    rate: computeRating(ds, achievements, { onlyrate: true }).toLowerCase(),
    rating: computeRating(ds, achievements),
    fc: pickOne(['fc', 'fc', 'fcp', 'ap', 'app']),
    fs: pickOne([null, 'sync', 'fs', 'fsd']),
  }
}

/** 35 SD + 15 DX 的 B50 fixture（画布 1400×1600 的 7+3 行口径） */
function makeB50() {
  const band = (lo, hi) => mai.totalList.root.filter(s => s.song_id >= lo && s.song_id < hi)
  const mkList = (cands, count) => {
    for (let i = cands.length - 1; i > 0; i--) {
      const j = pick(i + 1); [cands[i], cands[j]] = [cands[j], cands[i]]
    }
    return cands.slice(0, count).map(s => makeRecord(s, bestChart(s))).sort((a, b) => b.rating - a.rating)
  }
  const sd = mkList(band(0, 10000), 35)
  const dx = mkList(band(10000, 100000), 15)
  const sdTotal = sd.reduce((a, r) => a + r.rating, 0)
  const dxTotal = dx.reduce((a, r) => a + r.rating, 0)
  return {
    player: {
      name: '测试玩家',
      rating: sdTotal + dxTotal,
      course_rank: 9,
      class_rank: 14,
      trophy: { id: 1, name: 'れっつゴー！', color: 'Rainbow' },
    },
    best50: { sd, dx, sd_total: sdTotal, dx_total: dxTotal },
  }
}

/**
 * 资源包里挑一张**体积最大**的图作本地命中样本（包未装/目录为空时返回 null）：
 * 大文件即内容多的真图，目检时看得清裁切与比例；按名字取首张会拿到 1.webp 这类空占位图
 */
function packedId(type) {
  try {
    const dir = path.join(staticRoot, 'mai', type)
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.webp'))
    if (!files.length) return null
    const best = files
      .map(n => ({ n, size: fs.statSync(path.join(dir, n)).size }))
      .sort((a, b) => b.size - a.size)[0]
    console.log(`  · 本地样本 ${type}/${best.n}（${(best.size / 1024).toFixed(1)}KB）`)
    return Number(path.basename(best.n, '.webp'))
  } catch {
    return null
  }
}

/** 资源包该类型的 id 集合 */
function packedIds(type) {
  try {
    return new Set(fs.readdirSync(path.join(staticRoot, 'mai', type))
      .filter(n => n.endsWith('.webp')).map(n => Number(path.basename(n, '.webp'))))
  } catch {
    return new Set()
  }
}

const onlineCutout = (type, id) =>
  `https://www.yuzuchan.moe/assets/maimaidx/${type}/UI_${type[0].toUpperCase()}${type.slice(1)}_${String(id).padStart(6, '0')}.png`

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (res.body?.cancel) await res.body.cancel()
    return res.ok
  } catch {
    return false
  }
}

/**
 * 找一个「包内没有、上游有」的 id —— 缺图分支必须用它，否则在线取图 404、三页里两页都退成默认图，
 * 看不出「在线取 + 落盘缓存」这条分支。
 * 先拿 id 302（本机 data/assets 里那张在线 icon 的缓存来源，上游必有）探网络，
 * 网络不通就直接放弃该分支（不是代码问题，脚本如实标注）。
 * @returns {Promise<number|null>}
 */
/** 包内最小的缺失 id（保证本地无图，不依赖网络）——在线分支取不到样本时的兜底 */
function firstGap(packed) {
  for (let id = 1; id <= 2000; id++) if (!packed.has(id)) return id
  return 9999999
}

async function pickOnlineMiss(type, packed) {
  if (!await reachable(onlineCutout('icon', 302))) {
    console.error(`  ! 上游不可达（${onlineCutout('icon', 302)}）——跳过在线分支`)
    return null
  }
  // 资源包是按「上游存在的 id」抓的，缺号多为上游也没有的号；故只探**包内 id 的邻居**
  // （游戏内收藏品编号成串发放，邻居最可能上游有而包里漏了），且并发探以免逐个超时拖成几分钟
  const cands = []
  for (const id of packed) {
    for (const d of [1, 2, -1, -2, 100, -100]) {
      const c = id + d
      if (c > 0 && !packed.has(c) && !cands.includes(c)) cands.push(c)
    }
  }
  for (let i = 0; i < cands.length; i += 60) {
    const batch = cands.slice(i, i + 60)
    const hit = await Promise.all(batch.map(async id => ((await reachable(onlineCutout(type, id))) ? id : null)))
    const ok = hit.filter(v => v != null).sort((a, b) => a - b)[0]
    if (ok != null) return ok
  }
  return null
}

/** 渲染一页并回读头部两处切图最终的 src（ensureLocalAssets 会就地改写视图对象） */
async function shotPage(name, player) {
  const f = makeB50()
  const view = b50View({
    theme: 'prism_plus', qqid: null,
    player: { ...f.player, ...player }, best50: f.best50,
    serviceName: 'Lxns-Network', botName: 'MaiTest',
  })
  const ok = await shot(name, await renderBest50(view))
  const at = (x, y) => view.images.find(im => im.x === x && im.y === y)?.src ?? '(缺)'
  const short = s => (s.length > 78 ? `${s.slice(0, 40)}…${s.slice(-34)}` : s)
  console.log(`     plate → ${short(at(300, 60))}`)
  console.log(`     icon  → ${short(at(305, 65))}`)
  return ok
}

await loadMusic()

const localIcon = packedId('icon')
const localPlate = packedId('plate')
console.log(`资源包：icon ${localIcon ?? '无'} / plate ${localPlate ?? '无'}`)

const results = {}
console.log('渲染中…')

// —— ① 本地命中（资源包有该 id 时才有意义）——
if (localIcon != null && localPlate != null) {
  console.log(`[1/3] iconplate-local（包内 id icon=${localIcon} plate=${localPlate}）`)
  results['iconplate-local'] = await shotPage('iconplate-local', {
    icon: { id: localIcon }, name_plate: { id: localPlate },
  })
} else {
  console.error('[skip] iconplate-local：资源包缺少 mai/icon 或 mai/plate 下的 webp')
}

// —— ② 本地缺失 → 在线取 + 落盘缓存 ——
console.log('[2/3] iconplate-online（找「包内无、上游有」的 id，需联网）')
const missIcon = await pickOnlineMiss('icon', packedIds('icon'))
const missPlate = await pickOnlineMiss('plate', packedIds('plate'))
if (missIcon != null && missPlate != null) {
  console.log(`  · 缺图样本 icon=${missIcon} plate=${missPlate}（期望 src 渲染后变成 data/assets/<sha1>.png）`)
  results['iconplate-online'] = await shotPage('iconplate-online', {
    icon: { id: missIcon }, name_plate: { id: missPlate },
  })
} else {
  console.error('[skip] iconplate-online：上游没有可用样本 id（离线或该目录取不到图）')
}

// —— ③ assetsOnline=false：不触网，直接默认图（仅改内存配置副本，不落盘）——
// 样本优先用在线分支那个「上游确实有」的 id：这样第 ②③ 页只差一个开关，
// 「是开关在拦」而非「该 id 本来就没图」一目了然；取不到样本则退回包内最小缺口（同样保证本地无图）
const offIcon = missIcon ?? firstGap(packedIds('icon'))
const offPlate = missPlate ?? firstGap(packedIds('plate'))
const userCfg = Config.getConfig('config')
const savedOnline = userCfg.assetsOnline
userCfg.assetsOnline = false
try {
  console.log(`[3/3] iconplate-off（assetsOnline=false，样本 id icon=${offIcon} plate=${offPlate}）`)
  results['iconplate-off'] = await shotPage('iconplate-off', {
    icon: { id: offIcon }, name_plate: { id: offPlate },
  })
} finally {
  userCfg.assetsOnline = savedOnline
}

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([k]) => k)
const all = Object.keys(results).length
console.log(`\n渲染冒烟：${all - failed.length}/${all} 页通过`)
if (failed.length) {
  console.error('失败页：', failed.join(', '))
  process.exit(1)
}
process.exit(0) // 宿主渲染器 watcher 保持事件循环，主动退出
