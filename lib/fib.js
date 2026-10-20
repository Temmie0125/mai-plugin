/**
 * 弗一把（fib）——猜谱面游戏（参照 phi-plugin apps/guessGame/frib19 + frib19Utils）
 *
 * 玩法：`#mai fib [颜色][定数]` 从指定难度 + 定数范围抽一张谱面作谜底，玩家用
 * 曲名/别名/id 免前缀竞猜，每次猜测渲染一张七列对比表（谱师/Version/分类/类型/
 * 定数/BPM/物量），以 ✓相同 / 近·相近 / 灰·不同 / —·未知 四态 + ↑↓ 箭头给线索。
 *
 * 结构分工与猜歌同款：纯判定函数与状态机都在本模块（前者仿 frib19Utils 可单测），
 * 状态存 lib/guess.js 的共享 games 注册表（type:'fib'，与猜歌/猜曲绘/开字母互斥）。
 * `#mai ans` 走 guess.js 的 finishGame 通用出口——通过挂在 game 对象上的 reveal 钩子
 * 回调本模块出最终图，避免 guess.js ↔ fib.js 循环引入。
 *
 * QQBot 说明：本游戏是**猜测驱动**——每条玩家消息都会刷新适配器侧的被动回复锚点
 * （QQBot-Plugin pick.js 的 _passiveAnchor），回复挂载其上，不存在定时刷提示的撞限面；
 * 部分群的「每人每分钟 5 条」是群主自设的发言限制，与官方 Bot 无关，冷却项按需配置即可。
 */
import Config from './config.js'
import { mai } from './service.js'
import { findSongCandidates } from './pickSong.js'
import { gameOf, putGame, finishGame, schedule } from './guess.js'
import { coverSrc } from './render/assets.js'
import { renderFib, toSegment } from './render/picmodle.js'
import { cmdHead } from './qqbot.js'

const logger = global.logger || console

// =====================================================================
// 常量
// =====================================================================

/** 属性对比结果：相同 / 相近 / 不同 / 数据未知 */
export const FIB_STATE = {
  SAME: 'same',
  NEAR: 'near',
  DIFF: 'diff',
  UNKNOWN: 'unknown',
}

/** 箭头方向：答案更高/更新 / 答案更低/更早 / 无 */
export const FIB_ARROW = {
  UP: 'up',
  DOWN: 'down',
  NONE: '',
}

/** 属性数据缺失时展示的占位文本 */
export const FIB_UNKNOWN_TEXT = '—'

/**
 * 可指定的难度位次（与 DIFFS 一一对应）；cn 即绿黄红紫白难度色字，
 * 命令参数与版式标签共用这一份
 */
export const FIB_LEVELS = [
  { cn: '绿', en: 'Basic', cls: 'basic' },
  { cn: '黄', en: 'Advanced', cls: 'advanced' },
  { cn: '红', en: 'Expert', cls: 'expert' },
  { cn: '紫', en: 'Master', cls: 'master' },
  { cn: '白', en: 'Re:Master', cls: 'remaster' },
]

/** 缺省难度：紫谱（Master） */
export const FIB_DEFAULT_LEVEL_INDEX = 3

/**
 * 版本「代」块表（升序），与曲库数据里 LXNS versions 表逐项一致（20 代）。
 *
 * version_int 是**子版本**（如 20106 = 舞萌DX 代内的追加曲、25504 = PRiSM PLUS 代内的
 * 排位曲），不能直接比差值（ORANGE→ORANGE PLUS 差 1000，でらっくす→2021 只差 1000 但
 * 中间还隔了个 PLUS 代）。比较一律先折算成「代序号」：不超过它的最大块。
 *   SD：初/真/超/檄/橙/暁/桃/櫻/紫/菫/白/雪/輝
 *   DX：舞萌DX(熊華)/2021(爽煌)/2022(宙星)/2023(祭祝)/2024(双宴)/2025(鏡)/2026(彩)
 */
export const FIB_VERSION_BLOCKS = [
  10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 18500,
  19000, 19500, 19900, 20000, 21000, 22000, 23000, 24000, 25000, 25500,
]

/** 版本代 → 版本字（牌），展示 Version 列的副文本用 */
const FIB_BLOCK_KANJI = {
  10000: '初', 11000: '真', 12000: '超', 13000: '檄', 14000: '橙', 15000: '暁',
  16000: '桃', 17000: '櫻', 18000: '紫', 18500: '菫', 19000: '白', 19500: '雪', 19900: '輝',
  20000: '熊華', 21000: '爽煌', 22000: '宙星', 23000: '祭祝', 24000: '双宴', 25000: '鏡', 25500: '彩',
}

/** 默认的参与人数次数表：1 人起依次为 8/9/10/12/14/17/20 次，更多人保持最后一个值（同 phi） */
export const DEFAULT_FIB_GUESS_NUM_TABLE = [8, 9, 10, 12, 14, 17, 20]

export const DEFAULT_FIB_IDLE_TIMEOUT = 600
export const DEFAULT_FIB_SELF_CD = 3
export const DEFAULT_FIB_GROUP_CD = 0
/** 版本相近容忍代数：1 即相邻代（ORANGE↔ORANGE PLUS）判相近 */
export const DEFAULT_FIB_NEAR_VERSION = 1
export const DEFAULT_FIB_NEAR_DS = 0.5
export const DEFAULT_FIB_NEAR_BPM = 20
export const DEFAULT_FIB_NEAR_NOTES = 200

// =====================================================================
// 配置解析（纯函数，便于单测；非法值回退默认并告警，与 lib/guess.js 同口径）
// =====================================================================

/**
 * ⚠️ 与 lib/guess.js 的 pickNumber 不同：**不取整**。fibNearDs 的合理值是 0.5 这类
 * 小数，Math.round 会把它悄悄打成 1；整数字段交给 min/max 范围约束即可
 */
function pickNumber(conf, key, fallback, min, max) {
  const raw = conf?.[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const v = Number(raw)
  if (!Number.isFinite(v) || v < min || v > max) {
    logger.warn(`[mai-plugin] ${key} 非法（${JSON.stringify(raw)}），已回退默认 ${fallback}`)
    return fallback
  }
  return v
}

/**
 * 解析参与人数次数表配置（phi parseGuessNumTable 直译），非法或为空时回退默认表
 * @param {unknown} text 形如 "8,9,10,12,14,17,20"，也接受数字数组
 * @returns {number[]}
 */
export function parseGuessNumTable(text) {
  const raw = Array.isArray(text) ? text : String(text ?? '').split(/[,，\s]+/)
  const values = raw
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => Math.floor(value))
  return values.length ? values : [...DEFAULT_FIB_GUESS_NUM_TABLE]
}

/**
 * 按参与人数取本局可猜次数，人数超过表长时取表内最后一个值（phi guessNumLimit 直译）
 */
export function guessNumLimit(players, table = DEFAULT_FIB_GUESS_NUM_TABLE) {
  const list = table.length ? table : DEFAULT_FIB_GUESS_NUM_TABLE
  const count = Number.isFinite(players) ? Math.floor(players) : 1
  const index = Math.min(Math.max(count, 1), list.length) - 1
  return list[index]
}

/**
 * 弗一把八项配置（纯函数，便于单测）
 * @param {object} [cfg] 注入用；默认读用户配置
 */
export function resolveFibConfig(cfg = null) {
  const conf = cfg ?? Config.getUserCfg('config')
  return {
    guessNumTable: parseGuessNumTable(conf.fibGuessNumTable ?? DEFAULT_FIB_GUESS_NUM_TABLE),
    idleTimeout: pickNumber(conf, 'fibIdleTimeout', DEFAULT_FIB_IDLE_TIMEOUT, 10, 3600),
    selfCd: pickNumber(conf, 'fibSelfCd', DEFAULT_FIB_SELF_CD, 0, 600),
    groupCd: pickNumber(conf, 'fibGroupCd', DEFAULT_FIB_GROUP_CD, 0, 600),
    nearVersion: pickNumber(conf, 'fibNearVersion', DEFAULT_FIB_NEAR_VERSION, 0, 10),
    nearDs: pickNumber(conf, 'fibNearDs', DEFAULT_FIB_NEAR_DS, 0, 5),
    nearBpm: pickNumber(conf, 'fibNearBpm', DEFAULT_FIB_NEAR_BPM, 0, 1000),
    nearNotes: pickNumber(conf, 'fibNearNotes', DEFAULT_FIB_NEAR_NOTES, 0, 5000),
  }
}

// =====================================================================
// 起手参数与谜底池
// =====================================================================

/**
 * 解析开局参数，如「红12+」「白12.5-14」「13.6」「紫」。
 * 只给一个定数（含 `12` / `12+` / `14.9`）一律视为**下限 ≥**（phi 语义，已确认）；
 * 想要精确匹配写区间 `13.6-13.6`。区间连接符 -/~（含全角 ～－），端点自动排序。
 * 空参 = 紫谱全定数。
 * @returns {{ levelIndex: number, min: number | null, max: number | null } | null} 无法识别时 null
 */
export function parseFibArgs(raw) {
  const text = String(raw ?? '').replace(/\s+/g, '')
  if (!text) return { levelIndex: FIB_DEFAULT_LEVEL_INDEX, min: null, max: null }
  const m = text.match(/^([绿黄红紫白])?(?:(\d+(?:\.\d+)?)(?:\+|＋)?(?:[-~～－](\d+(?:\.\d+)?))?)?$/)
  if (!m) return null
  const levelIndex = m[1] ? FIB_LEVELS.findIndex(l => l.cn === m[1]) : FIB_DEFAULT_LEVEL_INDEX
  let min = null
  let max = null
  if (m[2] !== undefined) {
    const a = Number(m[2])
    if (m[3] === undefined) {
      min = a
    } else {
      const b = Number(m[3])
      ;[min, max] = a <= b ? [a, b] : [b, a]
    }
  }
  return { levelIndex, min, max }
}

/**
 * 构造谜底池：**本局难度有谱面且定数在范围内**的曲目才算（无该难度的曲绝不进池，
 * 保证谜底在七列上都有值）；宴谱（id ≥ 100000）不参与
 * @returns {any[]}
 */
export function buildFibPool(levelIndex, min, max) {
  const pool = []
  for (const song of mai.totalList.root) {
    if (song.song_id >= 100000) continue
    const diff = chartOf(song, levelIndex)
    if (!diff) continue
    const ds = diff.level_value
    if (min != null && ds < min) continue
    if (max != null && ds > max) continue
    pool.push(song)
  }
  return pool
}

/** 用法提示（参数解析失败时回复，绝不静默） */
export const fibUsage = () =>
  `弗一把用法：#${cmdHead()} fib [绿黄红紫白][定数]\n`
  + `例：#${cmdHead()} fib（紫谱随机）、#${cmdHead()} fib 红12+、#${cmdHead()} fib 白12.5-14、#${cmdHead()} fib 13.6+\n`
  + '难度省略默认紫谱（Master）；定数单值为下限，区间用 - 或 ~ 连接'

// =====================================================================
// 属性对比（纯函数；四态 same/near/diff/unknown + 箭头 up/down）
// =====================================================================

/**
 * version_int → 版本代序号（不超过它的最大块）；缺失/无法解析时 -1。
 * ⚠️ 必须显式排除 null/空串：Number(null) === 0 是有限数，裸用会把「无数据」误判成初代
 */
export function versionOrder(versionInt) {
  const v = Number(versionInt)
  if (versionInt == null || versionInt === '' || !Number.isFinite(v)) return -1
  let order = 0
  for (let i = 0; i < FIB_VERSION_BLOCKS.length; i++) {
    if (v >= FIB_VERSION_BLOCKS[i]) order = i
  }
  return order
}

/** 版本代 → 版本字（牌），如 20106 → 熊華 */
export function versionKanji(versionInt) {
  return FIB_BLOCK_KANJI[FIB_VERSION_BLOCKS[versionOrder(versionInt)]] ?? ''
}

/**
 * 版本对比：相近范围为前后若干代。同代即相同——子版本差异（20100 与 20106 同属
 * 舞萌DX 代）不影响判定
 */
export function compareVersion(guessInt, answerInt, tolerance) {
  const go = versionOrder(guessInt)
  const ao = versionOrder(answerInt)
  if (go < 0 || ao < 0) return { state: FIB_STATE.UNKNOWN, arrow: FIB_ARROW.NONE }
  const diff = ao - go
  const state = diff === 0
    ? FIB_STATE.SAME
    : Math.abs(diff) <= tolerance ? FIB_STATE.NEAR : FIB_STATE.DIFF
  const arrow = diff > 0 ? FIB_ARROW.UP : diff < 0 ? FIB_ARROW.DOWN : FIB_ARROW.NONE
  return { state, arrow }
}

/**
 * 数值对比（定数/BPM/物量通用）：差 ≤ tolerance 即相近；箭头指向答案一侧
 */
export function compareNumber(guess, answer, tolerance) {
  if (!Number.isFinite(guess) || !Number.isFinite(answer)) {
    return { state: FIB_STATE.UNKNOWN, arrow: FIB_ARROW.NONE }
  }
  const diff = answer - guess
  const abs = Math.abs(diff)
  return {
    state: abs === 0 ? FIB_STATE.SAME : abs <= tolerance ? FIB_STATE.NEAR : FIB_STATE.DIFF,
    arrow: diff > 0 ? FIB_ARROW.UP : diff < 0 ? FIB_ARROW.DOWN : FIB_ARROW.NONE,
  }
}

/**
 * 文本对比（谱师/分类/类型）：大小写与首尾空白不敏感，只有相同/不同两态
 */
export function compareText(guess, answer) {
  const a = String(guess ?? '').trim().toLowerCase()
  const b = String(answer ?? '').trim().toLowerCase()
  if (!a || !b) return { state: FIB_STATE.UNKNOWN, arrow: FIB_ARROW.NONE }
  return { state: a === b ? FIB_STATE.SAME : FIB_STATE.DIFF, arrow: FIB_ARROW.NONE }
}

/**
 * 计算回答冷却剩余：个人冷却与群冷却同时生效，取剩余更长的一项（phi guessCooldown 直译）
 * @returns {{ kind: 'self' | 'group' | '', seconds: number }} kind 为空表示不在冷却中
 */
export function fibCooldown({ now, selfSeconds, groupSeconds, lastSelf, lastGroup }) {
  const selfLeft = selfSeconds * 1000 - (now - lastSelf)
  const groupLeft = groupSeconds * 1000 - (now - lastGroup)
  if (selfLeft <= 0 && groupLeft <= 0) return { kind: '', seconds: 0 }
  const selfFirst = selfLeft >= groupLeft
  return {
    kind: selfFirst ? 'self' : 'group',
    seconds: Math.ceil((selfFirst ? selfLeft : groupLeft) / 1000),
  }
}

// =====================================================================
// 猜测行组装
// =====================================================================

/**
 * 本局难度上的谱面；不存在或定数非法时 null（该行谱师/定数/物量降级「未知」。
 * 谜底必有谱（池子保证），猜测曲不保证——「—」本身就是排除线索）
 */
function chartOf(song, levelIndex) {
  const d = song?.difficulties?.[levelIndex]
  if (!d || !(Number(d.level_value) > 0)) return null
  return d
}

/** BPM 防御性解析：曲库为数字，兼容 "150" / "150-300"（取首个数值）写法 */
function parseBpm(value) {
  const m = String(value ?? '').match(/\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) && n > 0 ? n : null
}

const fmtDs = v => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : '')
const fmtInt = v => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : '')

/**
 * 组合展示文本与对比结果，数据缺失时统一降级「未知」（phi buildItem 同款）
 */
function buildItem(value, result, sub = '') {
  const text = value == null || value === '' ? '' : String(value)
  return {
    value: text || FIB_UNKNOWN_TEXT,
    ...(text && sub ? { sub } : {}),
    state: text ? result.state : FIB_STATE.UNKNOWN,
    arrow: text ? result.arrow : FIB_ARROW.NONE,
  }
}

/**
 * 生成一行猜测记录（七列 = 谱师/Version/分类/类型/定数/BPM/物量）
 * 定数/物量/谱师均取**本局难度**的谱面；定数副文本带字面等级（13.6 → 13+）
 * @param {object} guess 猜测曲目（曲库 Song）
 * @param {object} answer 谜底曲目
 * @param {object} ctx { player, levelIndex, nearVersion, nearDs, nearBpm, nearNotes }
 */
export function createFibRow(guess, answer, ctx) {
  const g = chartOf(guess, ctx.levelIndex)
  const a = chartOf(answer, ctx.levelIndex)
  const gBpm = parseBpm(guess?.bpm)
  const aBpm = parseBpm(answer?.bpm)
  const gNotes = g?.notes?.total
  const aNotes = a?.notes?.total
  return {
    player: ctx.player,
    songId: guess?.song_id,
    song: String(guess?.song_name ?? ''),
    hit: Number(guess?.song_id) === Number(answer?.song_id),
    charter: buildItem(g?.note_designer, compareText(g?.note_designer, a?.note_designer)),
    version: buildItem(
      guess?.version_str,
      compareVersion(guess?.version_int, answer?.version_int, ctx.nearVersion),
      versionKanji(guess?.version_int),
    ),
    genre: buildItem(guess?.genre, compareText(guess?.genre, answer?.genre)),
    type: buildItem(guess?.type, compareText(guess?.type, answer?.type)),
    ds: buildItem(fmtDs(g?.level_value), compareNumber(g?.level_value, a?.level_value, ctx.nearDs), g?.level),
    bpm: buildItem(fmtInt(gBpm), compareNumber(gBpm, aBpm, ctx.nearBpm)),
    notes: buildItem(fmtInt(gNotes), compareNumber(gNotes, aNotes, ctx.nearNotes)),
  }
}

/** 渲染行的固定列序（与模板表头一致） */
const FIB_COLUMNS = [
  ['charterCell', 'charter'],
  ['versionCell', 'version'],
  ['genreCell', 'genre'],
  ['typeCell', 'type'],
  ['dsCell', 'ds'],
  ['bpmCell', 'bpm'],
  ['notesCell', 'notes'],
]

/**
 * 猜测记录 → 模板行数据（cells 带各列 class，顺序与表头一致）
 */
export function toRenderRows(rows) {
  return rows.map(row => ({
    player: row.player,
    song: row.song,
    hit: row.hit,
    cells: FIB_COLUMNS.map(([cls, key]) => ({ cls, ...row[key] })),
  }))
}

/** 定数范围的展示文本（开局说明与图内标题共用） */
export function fibRangeText(min, max) {
  if (min == null && max == null) return '全定数'
  if (max == null) return `定数 ≥ ${min}`
  if (min == null) return `定数 ≤ ${max}`
  return `定数 ${min} ~ ${max}`
}

/** 对比上下文（本局阈值快照） */
function rowCtx(game, player = '') {
  return {
    player,
    levelIndex: game.levelIndex,
    nearVersion: game.cfg.nearVersion,
    nearDs: game.cfg.nearDs,
    nearBpm: game.cfg.nearBpm,
    nearNotes: game.cfg.nearNotes,
  }
}

/**
 * 组装渲染视图（fib.html 纯数据驱动）
 * 背景衬**最近一次猜测**的曲绘——绝不能用谜底的（会漏答案）
 */
export function buildFibView(game, { withAnswer = false } = {}) {
  const level = FIB_LEVELS[game.levelIndex]
  const answerRow = withAnswer
    ? toRenderRows([createFibRow(game.answer, game.answer, { ...rowCtx(game), player: '答案' })])[0]
    : null
  return {
    levelCn: level.cn,
    levelEn: level.en,
    levelCls: level.cls,
    rangeText: fibRangeText(game.min, game.max),
    round: game.rows.length,
    maxGuess: guessNumLimit(game.players.size, game.cfg.guessNumTable),
    rows: toRenderRows(game.rows),
    answerRow,
    nearVersion: game.cfg.nearVersion,
    nearDs: game.cfg.nearDs,
    nearBpm: game.cfg.nearBpm,
    nearNotes: game.cfg.nearNotes,
    players: game.players.size,
    timeout: game.cfg.idleTimeout,
    cmdHead: cmdHead(),
    bgCover: game.lastGuessId ? coverSrc(game.lastGuessId) : '',
  }
}

/** 渲染当前对比表（渲染失败时 img() 返回错误文案字符串，原样发送） */
async function tableImage(game, opts = {}) {
  const buf = await renderFib(buildFibView(game, opts))
  return Buffer.isBuffer(buf) ? toSegment(buf) : buf
}

// =====================================================================
// 对局状态（共享 lib/guess.js 的 games 注册表，type:'fib'）
// =====================================================================

/**
 * 时间缩放（**测试注入，生产恒为 1**；与 lib/guess.js 的 setTimeScale 同款约定）
 */
let timeScale = 1
export function setTimeScale(v) {
  timeScale = v
}
const ms = base => Math.max(0, Math.round(base * timeScale))

/** 结算文案（prefix 以换行结尾，后接对比表图） */
const FIB_TEXTS = {
  hit: winner => `恭喜 「${winner}」 猜对了！答案是：\n`,
  exhausted: () => '次数用尽，本局结束。答案是：\n',
  timeout: () => '长时间没有新的猜测，本局结束。答案是：\n',
}

/**
 * 结算（猜中/次数用尽/超时/`#mai ans` 四路共用）。
 * 走 finishGame 通用出口（endGame 清定时器 + 揭晓钩子），重复调用自动空转
 */
async function settle(gid, prefix) {
  const game = gameOf(gid)
  if (!game || game.type !== 'fib' || game.settled) return null
  game.settled = true
  game.end = true
  const parts = await finishGame(gid, prefix)
  if (parts && typeof game.send === 'function') await game.send(parts)
  return parts
}

/**
 * 重排空闲定时器（每次有效猜测后调用；判据是「距上次有效猜测」）
 * 复用 guess.js 的带校验 schedule：到点时对局已清/群开关已关则静默中止
 */
function scheduleIdle(gid, game) {
  if (game.idleTimer) clearTimeout(game.idleTimer)
  game.idleTimer = schedule(game, gid, ms(game.cfg.idleTimeout * 1000), async () => {
    await settle(gid, FIB_TEXTS.timeout())
  })
}

/**
 * 开一局弗一把（守卫由调用方完成：群聊/就绪/群开关/互斥）
 * @param {object} opts
 * @param {object} opts.answer 谜底曲目
 * @param {number} opts.levelIndex 难度位次 0-4
 * @param {number|null} opts.min 定数下限
 * @param {number|null} opts.max 定数上限
 * @param {Function} opts.send 发消息出口
 * @param {any} opts.starter 发起者 user_id
 * @param {string} opts.starterName 发起者展示名
 */
export function startFibGame(gid, { answer, levelIndex, min, max, send, starter, starterName }) {
  const game = {
    type: 'fib',
    answer,
    levelIndex,
    min,
    max,
    cfg: resolveFibConfig(),
    rows: [],
    guessedIds: new Set(),
    players: new Map(),
    lastGroupAt: 0,
    /** 最近一次猜测的曲 id（对比表背景用，绝不放谜底的） */
    lastGuessId: 0,
    starter,
    starterName,
    settled: false,
    end: false,
    timers: [],
    idleTimer: null,
    send,
  }
  // 揭晓钩子：#mai ans 由 lib/guess.js finishGame 回调至此出最终图（避免循环引入）
  game.reveal = prefix => revealFib(game, prefix)
  putGame(gid, game)
  scheduleIdle(gid, game)
  return game
}

/** 揭晓载荷：结算文案 + 带答案行的对比表 */
async function revealFib(game, prefix) {
  const img = await tableImage(game, { withAnswer: true })
  if (typeof img === 'string') return `${prefix}${img}`
  return [prefix, img]
}

/** 开局说明（含本局范围/阈值/次数表/冷却，全部来自配置，改配置不自相矛盾） */
export function fibBanner(game) {
  const level = FIB_LEVELS[game.levelIndex]
  const c = game.cfg
  return [
    `弗一把开始！谜底藏在 ${level.en}（${level.cn}谱 · ${fibRangeText(game.min, game.max)}）的谱面里`,
    '直接发送曲名 / 别名 / 数字 id 竞猜，我会按 7 项属性给线索：谱师 · Version · 分类 · 类型(SD/DX) · 定数 · BPM · 物量',
    '✓ 相同 ｜ 近 相近 ｜ 灰 不同 ｜ ↑ 答案更高/更新 ｜ ↓ 答案更低/更早 ｜ — 该曲无本局难度谱面',
    `相近范围：版本前后 ${c.nearVersion} 代 · 定数 ±${c.nearDs} · BPM ±${c.nearBpm} · 物量 ±${c.nearNotes}`,
    `可猜次数随参与人数变化：${c.guessNumTable.join('/')}；个人冷却 ${c.selfCd} 秒、全群 ${c.groupCd} 秒；空闲 ${c.idleTimeout} 秒自动揭晓`,
    `发 #${cmdHead()} ans 可提前结束本局`,
  ].join('\n')
}

/**
 * 应答（免前缀，由猜歌答题兜底类分流至此）
 * - 对不上任何曲库曲目 → return false 放行（不吞日常聊天，同猜歌）
 * - 别名命中多曲 → 提示用 id 精确猜（不耗次数）
 * - 冷却/重复 → 提示（不耗次数）
 * - 有效猜测 → 对比表图；猜中/次数用尽就地结算
 * @returns {Promise<boolean>} 是否消费该消息
 */
export async function guessFib(gid, text, playerName = '', userId = '') {
  const game = gameOf(gid)
  if (!game || game.type !== 'fib' || game.end) return false
  const raw = String(text ?? '').trim()
  if (!raw || raw.length > 64 || /^[#/]/.test(raw)) return false

  const resolved = findSongCandidates(raw, mai)
  if (!resolved) return false
  if (resolved.multi) {
    await game.send(`「${raw}」对应多首曲目，弗一把请用数字 id 精确猜`)
    return true
  }
  const song = resolved.song

  const now = Date.now()
  const cd = fibCooldown({
    now,
    selfSeconds: game.cfg.selfCd,
    groupSeconds: game.cfg.groupCd,
    lastSelf: game.players.get(userId)?.lastAt ?? 0,
    lastGroup: game.lastGroupAt,
  })
  if (cd.kind) {
    await game.send(`猜得太快啦，冷却还剩 ${cd.seconds} 秒`)
    return true
  }
  if (game.guessedIds.has(song.song_id)) {
    await game.send(`「${song.song_name}」刚才已经有人猜过啦`)
    return true
  }

  // 到这里才算有效猜测：计入参与者、冷却与次数
  const prev = game.players.get(userId)
  if (prev) {
    prev.lastAt = now
    prev.name = playerName || prev.name
  } else {
    game.players.set(userId, { name: playerName, lastAt: now })
  }
  game.lastGroupAt = now
  game.guessedIds.add(song.song_id)
  game.lastGuessId = song.song_id
  game.rows.push(createFibRow(song, game.answer, rowCtx(game, playerName)))

  if (song.song_id === game.answer.song_id) {
    await settle(gid, FIB_TEXTS.hit(playerName))
    return true
  }

  scheduleIdle(gid, game)
  const max = guessNumLimit(game.players.size, game.cfg.guessNumTable)
  if (game.rows.length >= max) {
    await settle(gid, FIB_TEXTS.exhausted())
    return true
  }
  await game.send(await tableImage(game))
  return true
}
