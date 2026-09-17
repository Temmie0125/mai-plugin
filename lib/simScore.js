/**
 * 歌50 模拟成绩（需求《b50扩展功能需求.md》「歌50」段的扩展）
 *
 * 职责：**参数 token → 模拟规格 → 合成的 PlayedResult**。纯函数、零 I/O、零网络、
 * 不依赖 `mai` 单例 —— 与 `lib/fit.js` 同款模块范式，可离线单测。
 *
 * 本文件是模拟 token 的**唯一声明处**（词表 + 解析 + 成绩构造 + 横幅文案），
 * `apps/score.js`（解析接线）与 `lib/variantSpec.js` 的 HELP_ROWS（帮助图描述）共用同一份词表。
 *
 * 命令形状：`#mai 歌50 [难度色]<曲名> [token …]`，**token 顺序任意**：
 *
 *   达成率  100.1145 / 100.1145% / 99.00 / 99%     ← 不带 dx 前缀的数值（0~101）
 *   评级    理论 / AP+（二者等价 = 101% + AP+）/ SS+ / SSS / 鸟+ / … / D
 *   同步    FDX+ FDX FSD+ FSD FS+ FS SYNC 单刷
 *   DX      dx1145（绝对分）/ dx99%（Max DX 占比）/ N星（N = 1..5）
 *   标志    FC FC+ AP AP+
 *
 * ⚠️ **dx 前缀是必需的**（需求方拍板）：不带前缀的数值一律是达成率。
 *    写 `1145` 会命中 `suspectDx` 的引导文案，而不是静默当成别的槽位。
 *
 * ⚠️ **语义边界（改动前先读，与需求方逐条确认过）**
 *
 * 1. **达成率或评级 = 模拟开关**。只给同步/DX/标志会报错引导，**绝不静默回落**到真实成绩
 *    ——否则用户以为在看模拟，实际看的是自己的真实数据。
 * 2. **达成率 101（含「理论」「AP+」写法）⇒ 标志强制 `app`**，用户同时写了别的标志也忽略
 *    （需求方口径：这种情况「无效」）。
 * 3. `AP+` 单独出现 = 理论；但**给了显式达成率时以显式为准**（`99.00 AP+` 不升格成 101）
 *    ——本功能是娱乐向模拟器，刻意允许「不自洽」的组合。
 * 4. 星数用 `lib/fsline.js` 的 `DX_TIERS` 口径（1★85 / 2★90 / 3★93 / 4★95 / 5★97），
 *    与渲染层 `lib/render/views.js` 的 `dxStar` **同一张表** ⇒ 「输入 3星 就显示 ☆3」。
 *    （需求口述的「3星=95%」实为 4 星线，已确认按代码库表走。）
 * 5. 本模块**不读 records、不写任何缓存** —— `tests/scoreWriteGuard.test.js` 锁死。
 */
import { computeRating, dxStar } from './calc.js'
import { DX_TIERS } from './fsline.js'
import { PlayedResult } from './merge/models.js'
import { normalizeRank, rankStart } from './variantSpec.js'

// =====================================================================
// 词表（本模块是唯一声明处）
// =====================================================================

/**
 * 同步标识 token → `fs` 字段取值（与 `constants.SYNC_MAP` / `SYNC_SP` 同一套既有取值，
 * 零新增概念）。`label` 是横幅上展示的写法。
 */
const SYNC_TOKEN = {
  'fdx+': { fs: 'fdxp', label: 'FDX+' },
  fdx: { fs: 'fdx', label: 'FDX' },
  'fsd+': { fs: 'fsdp', label: 'FSD+' },
  fsd: { fs: 'fsd', label: 'FSD' },
  'fs+': { fs: 'fsp', label: 'FS+' },
  fs: { fs: 'fs', label: 'FS' },
  sync: { fs: 'sync', label: 'SYNC' },
  单刷: { fs: null, label: '单刷' },
}

/** FC/AP 标志 token → `fc` 字段取值（`constants.COMBO_SP`） */
const COMBO_TOKEN = { fc: 'fc', 'fc+': 'fcp', ap: 'ap', 'ap+': 'app' }

/**
 * `fc` 字段取值 → 横幅展示名。
 *
 * ⚠️ 不能借 `constants.COMBO_PLUS`：那是**小写**形态 `['fc','fc+','ap','ap+']`
 * （与 `SYNC_PLUS` 同款，供解析用），直接印到图上就成了 `ap+`。
 * 图内标签的真正来源是 `render/views.js` 私有的 `COMBO_PLUS_ARR()`，纯渲染模块不宜反向依赖，
 * 故这张 4 项展示表就近放这里（改动时请与 views.js 的标签对齐）。
 */
const COMBO_LABEL = { fc: 'FC', fcp: 'FC+', ap: 'AP', app: 'AP+' }

/** 理论值的达成率（需求方口径：理论 = 101.0000%，即 AP+） */
export const THEORY_ACH = 101

/** 缺省参数：理论走「全最高档」，其余走常规档（需求方确认） */
const DEFAULT_SIM = { fs: 'fdx', label: 'FDX', star: 3, fc: 'fcp' }
const THEORY_SIM = { fs: 'fdxp', label: 'FDX+', star: 5, fc: 'app' }

/** 星数 → Max DX 占比（从 fsline 的 DX_TIERS 反查，单一来源避免漂移） */
const STAR_RATE = Object.fromEntries(
  DX_TIERS.filter(t => /^[1-5]$/.test(t.label)).map(t => [Number(t.label), t.rate]),
)

const NUM_RE = /^(\d+(?:\.\d+)?)%?$/
const DX_RE = /^dx(\d+(?:\.\d+)?)(%?)$/i
/** `N星` / `N★` 都收：后者让横幅文案可以原样复制回来当命令用 */
const STAR_RE = /^([1-5])[星★]$/

/** 达成率上限（与 `apps/rating.js` 的 COM_ERROR_TEXT.acc 同口径） */
const ACC_MAX = 101

// =====================================================================
// 解析
// =====================================================================

/**
 * 单个 token 归类
 * @returns {{slot:'acc'|'rank'|'theory'|'sync'|'dx'|'combo', ...}|null} null = 不是模拟 token
 */
function classifyToken(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return null

  // DX 必须先于「达成率数值」判定：`dx1145` 也长得像数值
  const dx = t.match(DX_RE)
  if (dx) {
    const value = parseFloat(dx[1])
    if (Number.isNaN(value)) return null
    return { slot: 'dx', mode: dx[2] ? 'pct' : 'abs', value }
  }
  const st = t.match(STAR_RE)
  if (st) return { slot: 'dx', mode: 'star', value: Number(st[1]) }

  const lower = t.toLowerCase()
  // ⚠️ 词表一律 Object.hasOwn：模拟 token 是**用户自由文本**，裸取会让
  // `toString`/`constructor` 命中原型链上的函数（真值），静默产出一个假成绩
  if (Object.hasOwn(SYNC_TOKEN, lower)) return { slot: 'sync', ...SYNC_TOKEN[lower] }
  if (Object.hasOwn(COMBO_TOKEN, lower)) return { slot: 'combo', fc: COMBO_TOKEN[lower] }

  if (t === '理论') return { slot: 'theory' }
  const rank = normalizeRank(t) // 含 鸟加/鸟+/鸟家/鸟 与大小写折叠
  if (rank) return { slot: 'rank', key: rank }

  const num = t.match(NUM_RE)
  if (num) {
    const value = parseFloat(num[1])
    if (Number.isNaN(value)) return null
    // ⚠️ 越界的裸数字**不算模拟 token**，而不是报「达成率越界」。它是彻头彻尾的歧义形态：
    //    `#mai 歌50 紫 799`（难度色在前、歌曲 id 在后）是既有合法写法，
    //    而 `#mai 歌50 白潘 99.00 FDX 1145 AP` 里的 `1145` 是想写 DX 分数。
    //    两者的 token 形状一模一样，剥到哪一侧都不对 ⇒ 一律不认，靠 needScore 文案提示 dx 前缀。
    if (value < 0 || value > ACC_MAX) return null
    return { slot: 'acc', value }
  }
  return null
}

const SLOT_NAME = { acc: '达成率', rank: '评级', theory: '达成率', sync: '同步标识', dx: 'DX 分数', combo: 'FC/AP 标志' }

/**
 * 从参数串右侧剥离模拟 token，返回「剩余 token（= 难度色 + 曲名）」与模拟规格。
 *
 * 剥离是**贪心的、遇到第一个不认识的 token 就停**：模拟参数永远是紧贴末尾的一段连续 token。
 * 保护规则：**至少留一个 token 当曲名**（`rest.length > 1` 才剥），
 * 否则 `#mai 歌50 D` 会把曲名整条吃掉、退化成「缺曲名」。
 *
 * @param {string} raw REG_SONG50 的捕获组 1
 * @returns {{rest:string[], sim:object|null, error:{code:string, detail?:object}|null}}
 *   `sim === null && error === null` ⇒ 不是模拟（调用方走原有真实成绩逻辑）
 */
export function splitSimTokens(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
  const rest = [...tokens]
  const taken = []
  while (rest.length > 1 && classifyToken(rest[rest.length - 1])) {
    taken.unshift(rest.pop())
  }
  // 一个模拟 token 都没剥出来 ⇒ 整条都是曲名（`紫 799` / `白潘` / `D` 走这里）
  if (!taken.length) return { rest: tokens, sim: null, error: null }
  return { rest, ...classify(taken) }
}

/**
 * 已剥离的 token 列表 → 模拟规格（同槽位重复 → 报错）
 */
function classify(taken) {
  let score = null // {kind:'acc'|'rank'|'theory', value?|key?}
  let sync = null
  let dx = null
  let combo = null
  let syncSeen = false

  for (const raw of taken) {
    const c = classifyToken(raw)
    if (!c) continue
    if (c.slot === 'acc') {
      if (score) return { sim: null, error: { code: 'dup', detail: { slot: SLOT_NAME.acc } } }
      score = { kind: 'acc', value: c.value }   // 范围已在 classifyToken 保证
    } else if (c.slot === 'rank') {
      if (score) return { sim: null, error: { code: 'dup', detail: { slot: SLOT_NAME.rank } } }
      score = { kind: 'rank', key: c.key }
    } else if (c.slot === 'theory') {
      if (score) return { sim: null, error: { code: 'dup', detail: { slot: SLOT_NAME.theory } } }
      score = { kind: 'theory' }
    } else if (c.slot === 'sync') {
      if (syncSeen) return { sim: null, error: { code: 'dup', detail: { slot: SLOT_NAME.sync } } }
      sync = { fs: c.fs, label: c.label }
      syncSeen = true
    } else if (c.slot === 'dx') {
      if (dx) return { sim: null, error: { code: 'dup', detail: { slot: SLOT_NAME.dx } } }
      if (c.mode === 'pct' && c.value > 100) return { sim: null, error: { code: 'dxPct' } }
      dx = { mode: c.mode, value: c.value }
    } else if (c.slot === 'combo') {
      if (combo) return { sim: null, error: { code: 'dup', detail: { slot: SLOT_NAME.combo } } }
      combo = c.fc
    }
  }

  // AP+ 单独出现 = 理论（需求方口径「理论 = 101.0000%（评级 AP+）」）
  if (!score && combo === 'app') score = { kind: 'theory' }
  if (!score) return { sim: null, error: { code: 'needScore' } }

  const ach = score.kind === 'theory' ? THEORY_ACH
    : score.kind === 'acc' ? score.value
      : rankStart(score.key)
  const theory = ach >= THEORY_ACH
  const d = theory ? THEORY_SIM : DEFAULT_SIM

  const usedSync = sync ?? { fs: d.fs, label: d.label }
  // 理论必然 AP+：用户写了别的标志也忽略
  const fc = theory ? 'app' : (combo ?? d.fc)

  return {
    sim: {
      ach,
      theory,
      fs: usedSync.fs,
      syncLabel: usedSync.label,
      dx: dx ?? { mode: 'star', value: d.star },
      fc,
    },
    error: null,
  }
}

/**
 * 错误码 → 回复文案（函数式条目为运行时错误，需要解析出来的上下文；照
 * apps/rating.js 的 comUsage / COM_ERROR_TEXT 范式）
 *
 * 无「达成率越界」码：越界的裸数字在 `classifyToken` 就不算模拟 token 了（见那里的注释）。
 */
export const SIM_ERROR_TEXT = {
  dxPct: 'DX 分数百分比应在 0%~100% 之间！',
  noLevel: d => `「${d.songName}」该难度没有定数，无法模拟。`,
  noNotes: d => `「${d.songName}」该难度缺少物量数据（曲库异常），无法推算 DX 分数。`,
  dxOver: d => `DX 分数 ${d.value} 超过该谱面上限 ${d.dxMax}。`,
}

/**
 * 渲染错误文案
 * @param {{code:string, detail?:object}} error
 * @param {{cmdHead:string}} ctx
 */
export function simErrorText(error, { cmdHead } = {}) {
  if (error?.code === 'needScore') {
    return [
      '模拟需要一个达成率或评级，例如：',
      '・达成率：100.1145% 或 99.00',
      '・评级：理论 / AP+ / SS+ / 鸟+',
      // 这条是给「写了裸数字」的人看的：裸数字既非模拟参数、也无法当曲名，
      // 最终就会落到这里（见 classifyToken 里对越界裸数字的注释）
      '・DX 分数要带 dx 前缀（dx1145 / dx99%），星数写 N星，裸数字会被当成曲名的一部分',
      `・完整示例：#${cmdHead} 歌50 白潘 理论 FDX+ 5星 AP+`,
    ].join('\n')
  }
  if (error?.code === 'dup') {
    return `模拟参数里重复指定了「${error.detail?.slot}」，请只写一个。`
  }
  const t = SIM_ERROR_TEXT[error?.code]
  return typeof t === 'function' ? t(error.detail ?? {}) : (t ?? '模拟参数无法识别。')
}

// =====================================================================
// 合成成绩
// =====================================================================

/**
 * 该曲 `level_value` 最高的谱面下标（模拟模式的默认难度，**不依赖玩家成绩**）
 *
 * ⚠️ `difficulties` 可能不足 5 项、或含 `level_value === 0` 的占位，须过滤；
 * **索引即 `level_index`**（与 `lib/render/views.js` 的 `song.difficulties[li].dx_score` 同约定）。
 * 定数同高时取 `level_index` 更小的一档（紫优先于白）。
 *
 * @returns {number|null} 无任何有效定数 → null
 */
export function defaultLevelIndex(song) {
  const list = song?.difficulties ?? []
  let best = null
  for (let i = 0; i < list.length; i++) {
    const lv = Number(list[i]?.level_value) || 0
    if (lv <= 0) continue
    if (best === null || lv > best.lv) best = { i, lv }
  }
  return best?.i ?? null
}

/**
 * 星数/百分比/绝对分 → 实际 DX 分数
 *
 * ⚠️ `dxStar` 的边界是 `<=`（恰好 85% 判成 ☆0），故星数形态要**反查校验**：
 * 不到目标档就 +1 直到相符。**刻意不改 `dxStar` 本身**——它同样影响真实 B50 的渲染。
 */
function resolveDx(spec, dxMax) {
  if (spec.mode === 'abs') {
    if (spec.value > dxMax) return { error: { code: 'dxOver', detail: { value: spec.value, dxMax } } }
    return { dxScore: Math.floor(spec.value) }
  }
  if (spec.mode === 'pct') {
    return { dxScore: Math.floor((dxMax * spec.value) / 100) }
  }
  const rate = STAR_RATE[spec.value] ?? 1
  let dx = Math.ceil(dxMax * rate)
  while (dx < dxMax && dxStar((dx / dxMax) * 100) < spec.value) dx++
  return { dxScore: dx }
}

/**
 * 合成一条成绩（歌50 的 repeat 填充源）
 *
 * @param {{song:object, levelIndex:number, levelValue:number, dxMax:number, sim:object}} p
 *   `levelValue` 由调用方从 `mai.totalLevelValueMap` 取——与图上定数行同源，
 *   保证「显示的定数」与「算出的 Rating」必然自洽。
 * @returns {{record:object, summary:string}|{error:{code:string, detail?:object}}}
 */
export function simRecord({ song, levelIndex, levelValue, dxMax, sim }) {
  const chart = song?.difficulties?.[levelIndex]
  const ds = Number(levelValue) || 0
  if (!ds) return { error: { code: 'noLevel', detail: { songName: song?.song_name ?? '' } } }
  // 物量缺失只可能是曲库异常：实测 1394 曲 / 5537 谱面**全部**有 notes.total 与 dx_score。
  // 与其静默出一个和图上不一致的星数，不如直接报错。
  if (!(Number(dxMax) > 0)) {
    return { error: { code: 'noNotes', detail: { songName: song.song_name } } }
  }

  const ach = sim.ach
  const resolved = resolveDx(sim.dx, dxMax)
  if (resolved.error) return resolved

  const dxScore = resolved.dxScore
  // 星数按渲染层的口径反推（views.js 也用 dxStar 现算）⇒ 横幅上的星数恒等于图上那一颗
  const star = dxStar((dxScore / dxMax) * 100)

  const record = PlayedResult({
    song_id: song.song_id,
    song_name: song.song_name,
    level: chart?.level ?? '',
    level_index: levelIndex,
    level_value: ds,
    type: song.type,
    rating: computeRating(ds, ach),
    achievements: ach,
    rate: computeRating(ds, ach, { onlyrate: true }).toLowerCase(),
    fc: sim.fc,
    fs: sim.fs,
    dx_score: dxScore,
    dx_star: star || null,
  })

  return { record, summary: `${ach.toFixed(4)}% ${sim.syncLabel} ${star}★ ${COMBO_LABEL[sim.fc] ?? sim.fc}` }
}
