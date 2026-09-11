/**
 * 猜歌 / 猜曲绘（源 `core/service/__init__.py:150-292` Guess + `commands/mai_guess.py`，
 * P3 实施文档 §4）
 *
 * ⚠️ 与源的关键差异——**不用阻塞式 sleep 循环**：
 * 源在一个 handler 里 `await asyncio.sleep()` 跑完 4 + 6×8 + 30 = 82 秒，会长时间占住该条消息的
 * 处理链，且群状态无法被其它消息感知。端口改为**定时器驱动**：起手建状态立即回执，用
 * `setTimeout` 排各轮；每个定时器到点时重新校验「群开关仍开 && 该群仍在局中 && 未结束」，
 * 任一不满足即中止并清理（对应源 `:50-55`、`:67-76` 的逐 tick 校验）。
 *
 * 状态是**进程内内存**（源 `Guess._group` dict 同语义），重启即失、无需持久化。
 */
import Config, { head } from './config.js'
import * as database from './database.js'
import { mai } from './service.js'
import {
  HIDDEN, resolveKeys, initialOf, encrypt, revealIn, containsLetter, isRowSolved, allSolved,
  boardText, openedText, revealCandidates,
} from './letterBoard.js'

const logger = global.logger || console

/**
 * 读一个数值配置项：缺省取默认；给了但非法（非数/越界）则警告并回退
 * 与 `lib/schedule.js:resolveAutoSyncCron` 同口径——配置写错不该让功能静默失灵
 */
function pickNumber(conf, key, fallback, min, max) {
  const raw = conf?.[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const v = Number(raw)
  if (!Number.isFinite(v) || v < min || v > max) {
    logger.warn(`[mai-plugin] ${key} 非法（${JSON.stringify(raw)}），已回退默认 ${fallback}`)
    return fallback
  }
  return Math.round(v)
}

// =====================================================================
// 时序配置（秒）
// =====================================================================

/**
 * 每轮特征提示的默认间隔（秒）
 *
 * ⚠️ **偏离源的 8 秒**（源 `mai_guess.py:56` 的 `asyncio.sleep(8)`）：QQ 群消息与官方 QQBot
 * 被动回复**均限每分钟 5 条**，而源的一局在任一 60 秒窗口内会发出 7 条
 * （t = 0/4/12/20/28/36/44/52）——必然撞限、后半局静默失败。
 * 15 秒恰好把峰值压到 4 条/分（0/15/30/45/60/75/90/105/135）。
 */
export const DEFAULT_ROUND_INTERVAL = 15
/** 揭晓等待默认值（秒；源为 30） */
export const DEFAULT_REVEAL_TIMEOUT = 30
/** 间隔下限：低于源的 8 秒没有意义，且撞限风险陡增 */
export const MIN_ROUND_INTERVAL = 8
export const MIN_REVEAL_TIMEOUT = 5

/**
 * 解析猜歌时序配置（纯函数，便于单测）
 * 非法值回退默认并告警（与 `lib/schedule.js:resolveAutoSyncCron` 同口径）
 * @param {object} [cfg] 注入用；默认读用户配置
 * @returns {{interval: number, timeout: number}} 单位秒
 */
export function resolveTiming(cfg = null) {
  const conf = cfg ?? Config.getUserCfg('config')
  return {
    interval: pickNumber(conf, 'guessRoundInterval', DEFAULT_ROUND_INTERVAL, MIN_ROUND_INTERVAL, 600),
    timeout: pickNumber(conf, 'guessRevealTimeout', DEFAULT_REVEAL_TIMEOUT, MIN_REVEAL_TIMEOUT, 3600),
  }
}

// =====================================================================
// 开字母配置（默认值取自 phi-plugin 的 Letter*）
// =====================================================================

export const DEFAULT_LETTER_COUNT = 8
export const DEFAULT_LETTER_IDLE_TIMEOUT = 300
export const DEFAULT_LETTER_CD = 0

/**
 * 开字母五项配置（纯函数，便于单测）
 * @param {object} [cfg] 注入用；默认读用户配置
 * @returns {{count:number, revealCd:number, guessCd:number, tipCd:number, idleTimeout:number}} 冷却与超时为秒
 */
export function resolveLetterConfig(cfg = null) {
  const conf = cfg ?? Config.getUserCfg('config')
  return {
    count: pickNumber(conf, 'letterSongCount', DEFAULT_LETTER_COUNT, 2, 30),
    revealCd: pickNumber(conf, 'letterRevealCd', DEFAULT_LETTER_CD, 0, 600),
    guessCd: pickNumber(conf, 'letterGuessCd', DEFAULT_LETTER_CD, 0, 600),
    tipCd: pickNumber(conf, 'letterTipCd', DEFAULT_LETTER_CD, 0, 600),
    idleTimeout: pickNumber(conf, 'letterIdleTimeout', DEFAULT_LETTER_IDLE_TIMEOUT, 10, 3600),
  }
}

// =====================================================================
// 曲子池（源 Guess.guess()，:163-174）
// =====================================================================

/** 热度阈值（源 `count > 10000`，**严格大于**） */
export const HOT_THRESHOLD = 10000

/** @type {any[]} */
let guessPool = []
/** @type {number[]} */
let hotIds = []

/**
 * 重建热门曲子池（启动时 + 每次曲库同步后调用）
 *
 * 源的两处缺陷在端口修掉（均登记为改进）：
 * ① 源的 `hot_music_ids` **只追加不清空**，重复调用会累积重复 id；
 * ② 源的 `guess_data()` 直接取 `difficulties[2]`/`[3]`（Expert/Master），
 *    宴谱（id ≥ 100000）与合并后不足 4 难度的曲会 `IndexError` ⇒ 端口先过滤。
 * @returns {number} 池子曲数
 */
export function rebuildGuessPool() {
  const pool = []
  const ids = []
  for (const song of mai.totalList.root) {
    if (song.song_id >= 100000) continue
    if (song.difficulties.length < 4) continue
    let count = 0
    for (const diff of song.difficulties) count += diff.stats?.cnt || 0
    if (count > HOT_THRESHOLD) {
      pool.push(song)
      ids.push(song.song_id)
    }
  }
  guessPool = pool
  hotIds = ids
  logger.mark(`[mai-plugin] 猜歌池重建完成：${pool.length} 曲（热度 > ${HOT_THRESHOLD}）`)
  return pool.length
}

/** 当前池子（副本，防调用方改坏） */
export function getGuessPool() {
  return guessPool
}

/** 当前池子的曲 id（排障/单测用） */
export function getHotIds() {
  return hotIds
}

// =====================================================================
// 对局状态
// =====================================================================

/** @type {Map<any, {type:'text'|'pic', song:any, img:any, answer:Set<string>, options:string[], end:boolean, timers:any[], send:Function, card:Function}>} */
const games = new Map()

/**
 * 时间缩放（**测试注入，生产恒为 1**；与 `lib/database.js:setDataRoot` 同款约定）
 * 无此旋钮就只能真等 82 秒才测得完整时序链；设为 0.001 可把整局压到 ~82ms。
 */
let timeScale = 1
export function setTimeScale(v) {
  timeScale = v
}
const ms = base => Math.max(0, Math.round(base * timeScale))

export function isPlaying(gid) {
  return games.has(gid)
}

export function gameOf(gid) {
  return games.get(gid) ?? null
}

/**
 * 结束并移除对局（源 `Guess.end` = `del self._group[gid]`），清掉全部定时器
 * @returns 被移除的对局，无则 null
 */
export function endGame(gid) {
  const game = games.get(gid)
  if (!game) return null
  for (const t of game.timers) clearTimeout(t)
  game.timers.length = 0
  games.delete(gid)
  return game
}

/** 仅测试用：清空全部对局 */
export function clearAllGames() {
  for (const gid of [...games.keys()]) endGame(gid)
}

/**
 * 排一个**受校验保护**的定时器：到点时若该局已被清掉/已结束/群开关已关，静默中止
 *
 * 这是端口替代源「每 tick 现查状态」的等价物 —— 源在每轮广播前查，
 * 端口在每次定时器触发时查，语义一致。
 */
function schedule(game, gid, delayMs, fn) {
  const timer = setTimeout(async () => {
    // 该局是否还在（reset/off/答对都会 endGame）
    if (games.get(gid) !== game || game.end) return
    if (!database.getGroup(gid).guess) {
      endGame(gid)
      return
    }
    try {
      await fn()
    } catch (error) {
      logger.error(`[mai-plugin] 猜歌定时器执行异常：${error?.message || error}`)
    }
  }, delayMs)
  game.timers.push(timer)
}

// =====================================================================
// 特征模板与答案（源 guess_data() :239-265）
// =====================================================================

/** 源逐一写死的 8 条特征模板（`的`/`不`/`没` 都是模板的一部分，空格亦照原样） */
export function cluePool(song) {
  const d = song.difficulties
  return [
    `的 Expert 难度是 ${d[2].level}`,
    `的 Master 难度是 ${d[3].level}`,
    `的分类是 ${song.genre}`,
    `的版本是 ${song.version_str}`,
    `的艺术家是 ${song.artist}`,
    `${song.type === 'SD' ? '不' : ''}是 DX 谱面`,
    `${d.length === 4 ? '没' : ''}有白谱`,
    `的 BPM 是 ${song.bpm}`,
  ]
}

/**
 * 抽 6 条特征（源 `random.sample(pool, 6)`：**不放回**，逐轮消费 options[0..5]）
 * @param {() => number} [rand] 注入随机源
 */
export function buildClues(song, rand = Math.random) {
  const rest = cluePool(song)
  const out = []
  for (let i = 0; i < 6 && rest.length; i++) {
    out.push(rest.splice(Math.floor(rand() * rest.length), 1)[0])
  }
  return out
}

/**
 * 答案集 = 该曲**全部别名** + 数字 id（源 `core/service/__init__.py:255-257`）
 *
 * ⚠️ 一处小改进（登记）：源把用户输入 `.lower()` 却**没有小写答案集**，于是含大写的别名
 * （实测服务端有 `2B`/`OW`/`TwisteD！XD` 等 14 个）永远猜不中。端口两侧都小写——
 * 这是补全源「大小写不敏感」的意图，**不是**引入模糊匹配（仍是精确相等）。
 */
export function buildAnswer(songId) {
  const row = mai.totalAliasList.byId(songId)[0]
  const set = new Set((row?.alias ?? []).map(a => String(a).toLowerCase()))
  set.add(String(songId))
  return set
}

/**
 * 判定（源 `mai_guess.py:123`：`ans.lower() in guess._group[gid].answer`）
 * 精确相等、无包含匹配、无用户去重；答错静默忽略（源没有 else 分支）
 */
export function isCorrect(gid, text) {
  const game = games.get(gid)
  if (!game || game.end) return false
  return game.answer.has(String(text ?? '').trim().toLowerCase())
}

// =====================================================================
// 开一局
// =====================================================================

/**
 * 猜歌起手文案（源 mai_guess.py:44-48 逐字）
 * 间隔数字是**配置项**，故做成函数（源把「8」写死在文案里，改时序就会自相矛盾）
 */
export const textBanner = interval =>
  '我将从热门乐曲中选择一首歌，'
  + `每隔${interval}秒描述它的特征，`
  + '请输入歌曲的「id」「标题」或「别名」进行猜歌（DX乐谱和标准乐谱视为两首歌）。'
  + '猜歌时查歌等其他命令依然可用。'
export const TEXT_ROUND7 = '7/7 这首歌封面的一部分是：\n'
export const textRound7Tail = timeout => `答案将在${timeout}秒后揭晓`
export const TEXT_PIC = '以下裁切图片是哪首谱面的曲绘：\n'
export const textPicTail = timeout => `请在${timeout}s内输入答案`
export const TEXT_REVEAL = '答案是：\n'
export const TEXT_CORRECT = '猜对了，答案是：\n'

/** 揭晓（源：`答案是：\n` + draw_chart_info(song)） */
async function reveal(game, prefix) {
  const payload = await game.card(game.song)
  if (typeof payload === 'string') return [prefix, payload]
  return [prefix, ...(Array.isArray(payload) ? payload : [payload])]
}

/**
 * 开一局猜歌（源 `mai_guess.py:35-82`：banner → 6 轮特征 → 第 7 轮裁片 → 揭晓）
 *
 * 与源的两处时序差异（均因消息限额，见 DEFAULT_ROUND_INTERVAL）：
 * ① 间隔 8 秒 → 可配（默认 15）；
 * ② **首轮不再单独等 4 秒**，直接用同一间隔——源那个 4 秒是随手写的头程，
 *    保留它会让「banner 后 4 秒第 1 轮、再 15 秒第 2 轮」的疏密不均，不如匀速。
 * @param {object} opts send(msg) 发消息、card(song) 出揭晓卡
 */
export function startTextGame(gid, { song, img, send, card }) {
  const { interval, timeout } = resolveTiming()
  const game = {
    type: 'text',
    song,
    img,
    answer: buildAnswer(song.song_id),
    options: buildClues(song),
    end: false,
    timers: [],
    send,
    card,
  }
  games.set(gid, game)

  schedule(game, gid, ms(0), () => send(textBanner(interval)))
  for (let i = 0; i < 6; i++) {
    schedule(game, gid, ms(interval * 1000 * (i + 1)), () => send(`${i + 1}/7 这首歌${game.options[i]}`))
  }
  schedule(game, gid, ms(interval * 1000 * 7), () => send([TEXT_ROUND7, img, textRound7Tail(timeout)]))
  schedule(game, gid, ms(interval * 1000 * 7 + timeout * 1000), async () => {
    game.end = true
    const parts = await reveal(game, TEXT_REVEAL)
    endGame(gid)
    await send(parts)
  })
  return game
}

/**
 * 开一局猜曲绘（源 `mai_guess.py:85-114`：直接发裁片 → 揭晓等待 → 揭晓）
 * @param {object} opts 同 startTextGame
 */
export function startPicGame(gid, { song, img, send, card }) {
  const { timeout } = resolveTiming()
  const game = {
    type: 'pic',
    song,
    img,
    answer: buildAnswer(song.song_id),
    options: [],
    end: false,
    timers: [],
    send,
    card,
  }
  games.set(gid, game)

  schedule(game, gid, ms(0), () => send([TEXT_PIC, img, textPicTail(timeout)]))
  schedule(game, gid, ms(timeout * 1000), async () => {
    game.end = true
    const parts = await reveal(game, TEXT_REVEAL)
    endGame(gid)
    await send(parts)
  })
  return game
}

// =====================================================================
// 开字母（参照 phi-plugin apps/guessGame/guessLetter.js）
// =====================================================================

/**
 * 抽 N 首作为题面
 * 过滤：排除宴谱（id ≥ 100000，标题是 `[協]…` 形式）、且曲名至少含一个**可开字符**
 * （表内汉字/假名，或拉丁字母数字）——全符号标题永远开不出来，进了池子只会卡住一行
 * @returns {any[]|null} 曲数不足时 null
 */
export function pickLetterSongs(n) {
  const keys = resolveKeys()
  const openable = ch => initialOf(ch, keys) != null || /[A-Za-z0-9]/.test(ch)
  const pool = mai.totalList.root.filter(s => s.song_id < 100000
    && Array.from(String(s.song_name ?? '')).some(openable))
  if (pool.length < n) return null
  // Fisher–Yates 取前 n：比 phi 那套「抽到重复就重抽（最多 50 次）」稳定，无失败分支
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, n)
}

/** 揭晓时的逐行答案（未猜出的也列出） */
export function letterAnswerLines(game) {
  return game.rows.map((row, i) => {
    const who = row.winner ? ` @${row.winner}` : ''
    return `${i + 1}. ${row.song.song_name}${who}`
  })
}

/**
 * 该文本能否对上**曲库里真实存在的**曲目（曲名 / 别名 / 数字 id）
 * 仅用于「这首不在本局里」的提示判定；大小写不敏感（`byName` 是精确匹配，故曲名自己扫一遍）
 */
function matchesLibrarySong(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return false
  const lower = raw.toLowerCase()
  if (/^\d+$/.test(raw) && mai.totalList.byId(parseInt(raw, 10))) return true
  if (mai.totalList.root.some(s => String(s.song_name ?? '').toLowerCase() === lower)) return true
  return mai.totalAliasList.byAlias(raw).length > 0
}

/** 该行接受的答案集：曲名 + 全部别名（两侧小写）。板面遮住了曲名，故 id 无从得知、不纳入 */
function letterAnswerSet(song) {
  const row = mai.totalAliasList.byId(song.song_id)[0]
  const set = new Set([String(song.song_name).toLowerCase()])
  for (const a of row?.alias ?? []) set.add(String(a).toLowerCase())
  return set
}

/**
 * 直接发答案 → 命中的行号（0-based）
 * **多行同名别名时返回多行**——由调用方一次性判对并说清（你要求的重复别名处理）
 */
export function matchLetterAnswer(gid, text) {
  const game = games.get(gid)
  if (!game || game.type !== 'letter' || game.end) return []
  const ans = String(text ?? '').trim().toLowerCase()
  if (!ans) return []
  const hits = []
  game.rows.forEach((row, i) => {
    if (isRowSolved(row)) return
    if (letterAnswerSet(row.song).has(ans)) hits.push(i)
  })
  return hits
}

/**
 * 重排空闲定时器（每次答对都重置：判据是「距上次答对」而非「距开局」）
 *
 * ⚠️ **必须先清掉上一个**：否则旧定时器仍按原时刻触发，答对等于没重置——
 * 这个漏网正是被 tests/letterGame.test.js 的「答对必须重置空闲计时」逮到的。
 */
function scheduleIdle(gid, game, cfg) {
  if (game.idleTimer) clearTimeout(game.idleTimer)
  game.idleTimer = setTimeout(async () => {
    if (games.get(gid) !== game || game.end) return
    if (!database.getGroup(gid).guess) {
      endGame(gid)
      return
    }
    const parts = await finishGame(gid, '呜，怎么还没有人答对啊QAQ！答案如下：\n')
    if (parts) await game.send(parts)
  }, ms(cfg.idleTimeout * 1000))
  game.timers.push(game.idleTimer)
  return game.idleTimer
}

/**
 * 开一局开字母
 * @param {object} opts send(msg) 发消息、starter 发起者 user_id、starterName 展示名
 * @returns {object|null} 建好的对局；已在对局中或曲数不足时 null（由调用方给文案）
 */
export function startLetterGame(gid, { send, starter, starterName, count = null }) {
  const cfg = resolveLetterConfig()
  const songs = pickLetterSongs(count ?? cfg.count)
  if (!songs) return null

  const game = {
    type: 'letter',
    starter,
    rows: songs.map(song => ({ song, blur: encrypt(song.song_name), winner: null })),
    opened: new Set(),
    lastRevealAt: 0,
    lastGuessAt: 0,
    end: false,
    timers: [],
    send,
  }
  games.set(gid, game)
  scheduleIdle(gid, game, cfg)
  return game
}

/** 板面正文（`开字母进行中…` + 已翻开字符 + 逐行遮罩） */
export function letterBoardText(game) {
  // 已翻开单独占一行（原先用全角空格接在同一行，手机上挤成一团）
  const opened = game.opened.size ? `\n已翻开[ ${openedText(game)} ]` : ''
  return `开字母进行中（共 ${game.rows.length} 首）${opened}\n\n${boardText(game)}`
}

/** 把 symbol 在所有未解出的行里翻开（`#open` 与 `#mai tips` 共用） */
function revealSymbol(game, symbol) {
  const keys = resolveKeys()
  let hit = false
  for (const row of game.rows) {
    if (isRowSolved(row)) continue
    if (!containsLetter(row.song.song_name, symbol, keys)) continue
    hit = true
    row.blur = revealIn(row.song.song_name, row.blur, symbol, keys)
    if (row.blur !== null && !row.blur.includes(HIDDEN)) row.blur = null
  }
  return hit
}

/**
 * 随机翻开一个字符（`#mai tips`，对齐 phi 的 `getTip`）
 *
 * 与 `#open X` 的三点差异（都是 phi 的语义）：
 * ① 翻的是**具体字符**而非指定字母——从所有仍隐藏的位置里等概率抽一个（重复保留，故长曲名更易被抽到）；
 * ② **会重置空闲计时**：用了提示就算有人在玩，不该被判超时；
 * ③ 受**独立的** `letterTipCd` 约束（与开字母冷却分开）。
 * @returns {Promise<{kind: string, symbol?: string}|null>} kind: cooldown | empty | tip | solved | null
 */
export async function tipLetter(gid) {
  const game = games.get(gid)
  if (!game || game.type !== 'letter' || game.end) return null
  const cfg = resolveLetterConfig()
  const now = Date.now()

  const wait = Math.ceil((game.lastTipAt + cfg.tipCd * 1000 - now) / 1000)
  if (cfg.tipCd > 0 && wait > 0) {
    await game.send(`使用提示的冷却还有 ${wait} 秒，先自己猜猜看～`)
    return { kind: 'cooldown' }
  }
  game.lastTipAt = now

  const candidates = revealCandidates(game)
  if (!candidates.length) {
    await game.send(`当前没有可以继续翻开的字符了，可发 #${head()} ans 结束本局`)
    return { kind: 'empty' }
  }
  const symbol = candidates[Math.floor(Math.random() * candidates.length)]
  revealSymbol(game, symbol)
  game.opened.add(String(symbol).toUpperCase())
  scheduleIdle(gid, game, cfg) // ②：用提示也续命（phi 同款）

  if (allSolved(game)) {
    const parts = await finishGame(gid, `已随机翻开字符[ ${symbol} ]，所有字母已翻开，答案如下：\n`)
    if (parts) await game.send(parts)
    return { kind: 'solved', symbol }
  }
  await game.send(`已随机翻开字符[ ${symbol} ]\n\n${letterBoardText(game)}`)
  return { kind: 'tip', symbol }
}

/**
 * 翻开一个字母（`#open X`）
 * 三分支与 phi 同：冷却中 / 该字母已开过 / 翻开（含「都不含此字母」）
 * @returns {Promise<{kind: string}|null>} kind: cooldown | dup | miss | opened | solved | null(无对局)
 */
export async function openLetter(gid, letter) {
  const game = games.get(gid)
  if (!game || game.type !== 'letter' || game.end) return null
  const cfg = resolveLetterConfig()
  const now = Date.now()

  // 冷却照 phi：即使这次没翻开任何字，也消耗冷却（源把 lastRevealedTime 记在判定之前）
  const wait = Math.ceil((game.lastRevealAt + cfg.revealCd * 1000 - now) / 1000)
  if (cfg.revealCd > 0 && wait > 0) {
    await game.send(`开字母冷却中，还需 ${wait} 秒`)
    return { kind: 'cooldown' }
  }
  game.lastRevealAt = now

  const key = String(letter).toUpperCase()
  if (game.opened.has(key)) {
    await game.send(`字符[ ${letter} ]已经翻开过啦，不用重复开`)
    return { kind: 'dup' }
  }

  const hit = revealSymbol(game, letter)

  if (!hit) {
    await game.send(`这几首曲目中不包含字母[ ${letter} ]\n\n${boardText(game)}`)
    return { kind: 'miss' }
  }
  game.opened.add(key)

  if (allSolved(game)) {
    const parts = await finishGame(gid, `成功翻开字母[ ${letter} ]，所有字母已翻开，答案如下：\n`)
    if (parts) await game.send(parts)
    return { kind: 'solved' }
  }
  await game.send(`成功翻开字母[ ${letter} ]\n\n${letterBoardText(game)}`)
  return { kind: 'opened' }
}

/**
 * 应答（直接发答案，免前缀）
 * 命中后：判对全部命中行（多行同名别名一次说清）→ 重置空闲计时 → 全揭开则收尾
 * @returns {Promise<{kind: string, hits?: number[]}|null>} kind: cooldown | miss | hit | solved
 */
export async function answerLetter(gid, text, winnerName = '') {
  const game = games.get(gid)
  if (!game || game.type !== 'letter' || game.end) return null
  const cfg = resolveLetterConfig()
  const now = Date.now()

  const wait = Math.ceil((game.lastGuessAt + cfg.guessCd * 1000 - now) / 1000)
  if (cfg.guessCd > 0 && wait > 0) {
    await game.send(`猜题冷却中，还需 ${wait} 秒`)
    return { kind: 'cooldown' }
  }
  game.lastGuessAt = now

  const hits = matchLetterAnswer(gid, text)
  if (!hits.length) {
    // 区分两种「没中」：
    // ① 答案确实对得上曲库里的某首歌、只是不在本局 → 给一句提示。
    //    否则玩家分不清「答错了」和「机器人根本没听见」，体验很差。
    // ② 对不上任何真实曲目 → 静默（多半只是日常聊天，不该被游戏打扰）。
    if (matchesLibrarySong(text)) {
      await game.send(`「${String(text).trim()}」不在本局里哦，再看看板面～`)
      return { kind: 'elsewhere' }
    }
    return { kind: 'miss' }
  }

  for (const i of hits) {
    game.rows[i].blur = null
    game.rows[i].winner = winnerName
  }
  scheduleIdle(gid, game, cfg) // 有新答对 ⇒ 空闲计时重置

  const lines = hits.map(i => `${i + 1}. ${game.rows[i].song.song_name} ✅`)
  const head = hits.length > 1
    ? `猜对了！这一答一次命中 ${hits.length} 首：\n${lines.join('\n')}`
    : `猜对了！${lines[0]}`

  if (allSolved(game)) {
    const parts = await finishGame(gid, `${head}\n所有字母已翻开，答案如下：\n`)
    if (parts) await game.send(parts)
    return { kind: 'solved', hits }
  }
  await game.send(`${head}\n\n${letterBoardText(game)}`)
  return { kind: 'hit', hits }
}

/**
 * 三类游戏通用收尾（超时 / `#mai ans` / 全部揭开 三处共用）
 * 揭晓文案按类型：猜歌→出卡；开字母→逐行列答案
 * @returns {Promise<Array|string|null>} 待发送载荷；无对局时 null
 */
export async function finishGame(gid, prefix = TEXT_REVEAL) {
  const game = endGame(gid)
  if (!game) return null
  game.end = true
  // ⚠️ 必须拼成**一个字符串**再发：返回 `[prefix, ...lines]` 这种纯文本数组时，
  // 宿主/适配器按消息段拼接文本**不加分隔符**，各行会粘成一坨（曾如此）。
  // 猜歌/猜曲绘走 reveal() 返回 [文案, 图片段, 附言]，那里含真 segment，不受影响。
  if (game.type === 'letter') return `${prefix}${letterAnswerLines(game).join('\n')}`
  return await reveal(game, prefix)
}

/** 答对收尾（源 `mai_guess.py:117-129`）：先结束并清定时器，再出卡 */
export async function finishCorrect(gid) {
  return await finishGame(gid, TEXT_CORRECT)
}
