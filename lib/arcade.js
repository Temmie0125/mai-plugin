/**
 * 机厅人数（群内互助上报）——数据层与纯逻辑
 *
 * 每个群维护自己的机厅表（data/arcade.json），机厅名与别名在**群内**构成统一命名空间
 * （名↔名、名↔别名、别名↔别名 均不可重，见 occupant）。成员免前缀口语交互：
 *   <名|别名>j / <名|别名>几   → 查询人数
 *   <名|别名><数字>            → 绝对上报（机厅3）
 *   <名|别名>±<数字>           → 增减上报（机厅+1 / 机厅-2）
 * 上报落「最后上报者展示名 + 时间戳」，查询时渲染相对时间（见 apps/arcade.js 的 queryText）。
 *
 * 持久化沿用 lib/database.js 的两条铁律：
 *   1) 行级 read-merge-write：写前重读磁盘，磁盘其它群一律保留（尊重外部进程/删除）；
 *   2) 原子写（lib/jsonFile.js）。
 * 机厅数据无凭据风险，故不做 .bak 备份轮转。落库为空表时删掉整群键，避免空壳膨胀。
 *
 * 测试/调试规范：**必须**先 setDataRoot(临时目录)，严禁对真机 data/ 直接读写。
 */
import path from 'node:path'
import { pluginRoot } from './path.js'
import { readJson, writeJsonAtomic } from './jsonFile.js'

let dataRoot = path.join(pluginRoot, 'data')

/** 测试注入数据目录（生产勿用） */
export function setDataRoot(dir) {
  dataRoot = dir
}

/** @type {Record<string, {arcades: Record<string, ArcadeRow>}> | null} */
let arcadeDb = null

/** 口语匹配正则缓存（键=群号字符串，值=RegExp 或 null 表「本群无机厅」）；任何写盘即整体失效 */
const regexCache = new Map()

/** @typedef {{count: number, aliases?: string[], reporter?: string, updatedAt?: number}} ArcadeRow */

/** 启动/测试载入（强制重读磁盘并清缓存） */
export function load() {
  arcadeDb = readJson(path.join(dataRoot, 'arcade.json'), {})
  regexCache.clear()
}

function db() {
  if (!arcadeDb) load()
  return arcadeDb
}

/** 测试/排障用：当前内存态 */
export function dump() {
  return { arcadeDb: db() }
}

/** 本群机厅表（只读视图，空群返回 {}；勿直接改写，一律走 create/remove/…） */
export function arcadesOf(gid) {
  return db()[String(gid)]?.arcades || {}
}

/**
 * 写回本群机厅表：磁盘为全集、仅覆盖本群键（行级 read-merge-write）；空表删整群键。
 * 同时令口语匹配正则缓存失效（变更罕见，整体清空即可）。
 */
function saveGroup(gid, arcades) {
  const key = String(gid)
  const file = path.join(dataRoot, 'arcade.json')
  const merged = { ...readJson(file, {}) }
  if (Object.keys(arcades).length) merged[key] = { arcades }
  else delete merged[key]
  arcadeDb = merged
  regexCache.clear()
  writeJsonAtomic(file, merged, { indent: 2 })
}

/* ---------------- 名称校验与占用查重 ---------------- */

/** 词语（机厅名或别名）校验 @returns {{word?: string, reason?: 'empty'|'has-arrow'|'too-long'}} */
function validateWord(raw) {
  const word = String(raw ?? '').trim()
  if (!word) return { reason: 'empty' }
  if (word.includes('->')) return { reason: 'has-arrow' }
  if (word.length > 24) return { reason: 'too-long' }
  return { word }
}

/** 群内「名称+别名」统一命名空间的占用者（返回占用它的机厅名，无占用返回 null） */
function occupant(arcades, word) {
  for (const [name, row] of Object.entries(arcades)) {
    if (name === word || row.aliases?.includes(word)) return name
  }
  return null
}

/** 群内按名称或别名解析机厅 @returns {{name: string, row: ArcadeRow} | null} */
export function resolve(gid, rawWord) {
  const word = String(rawWord ?? '').trim()
  if (!word) return null
  const arcades = arcadesOf(gid)
  if (arcades[word]) return { name: word, row: arcades[word] }
  for (const [name, row] of Object.entries(arcades)) {
    if (row.aliases?.includes(word)) return { name, row }
  }
  return null
}

/* ---------------- 管理操作（校验/查重都在这层，供单测） ---------------- */

/**
 * 创建机厅 @returns {{ok: true, name: string} | {ok: false, reason: string, holder?: string}}
 * reason：empty / has-arrow / too-long / exists（holder=占用者名）
 */
export function create(gid, rawName) {
  const { word, reason } = validateWord(rawName)
  if (!word) return { ok: false, reason }
  const arcades = { ...arcadesOf(gid) }
  const holder = occupant(arcades, word)
  if (holder) return { ok: false, reason: 'exists', holder }
  arcades[word] = { count: 0, aliases: [] }
  saveGroup(gid, arcades)
  return { ok: true, name: word }
}

/**
 * 删除机厅（按名称或别名；级联其全部别名）
 * @returns {{ok: true, name: string} | {ok: false, reason: 'not-found'}}
 */
export function remove(gid, rawWord) {
  const word = String(rawWord ?? '').trim()
  const hit = resolve(gid, word)
  if (!hit) return { ok: false, reason: 'not-found' }
  const arcades = { ...arcadesOf(gid) }
  delete arcades[hit.name]
  saveGroup(gid, arcades)
  return { ok: true, name: hit.name }
}

/**
 * 添加别名 @returns {{ok: true, name: string, alias: string}
 *   | {ok: false, reason: 'empty'|'has-arrow'|'too-long'|'not-found'|'exists', holder?: string}}
 */
export function addAlias(gid, rawName, rawAlias) {
  const name = String(rawName ?? '').trim()
  const { word: alias, reason } = validateWord(rawAlias)
  if (!name) return { ok: false, reason: 'empty' }
  if (!alias) return { ok: false, reason }
  const arcades = { ...arcadesOf(gid) }
  const hit = resolve(gid, name)
  if (!hit) return { ok: false, reason: 'not-found' }
  const holder = occupant(arcades, alias)
  if (holder) return { ok: false, reason: 'exists', holder }
  arcades[hit.name] = { ...hit.row, aliases: [...(hit.row.aliases || []), alias] }
  saveGroup(gid, arcades)
  return { ok: true, name: hit.name, alias }
}

/**
 * 删除别名 @returns {{ok: true, name: string, alias: string}
 *   | {ok: false, reason: 'empty'|'not-found'|'no-alias'}}
 */
export function removeAlias(gid, rawName, rawAlias) {
  const name = String(rawName ?? '').trim()
  const alias = String(rawAlias ?? '').trim()
  if (!name || !alias) return { ok: false, reason: 'empty' }
  const hit = resolve(gid, name)
  if (!hit) return { ok: false, reason: 'not-found' }
  const aliases = hit.row.aliases || []
  if (!aliases.includes(alias)) return { ok: false, reason: 'no-alias' }
  const arcades = { ...arcadesOf(gid) }
  arcades[hit.name] = { ...hit.row, aliases: aliases.filter(a => a !== alias) }
  saveGroup(gid, arcades)
  return { ok: true, name: hit.name, alias }
}

/**
 * 上报人数。action 二选一：{ abs: n } 绝对上报 / { delta: n } 增减上报。
 * 减到负数拒绝且**不落盘**（reason 'negative'，带回当前值 from）。
 * @returns {{ok: true, name: string, from: number, to: number}
 *   | {ok: false, reason: 'not-found'|'negative', name?: string, from?: number}}
 */
export function applyReport(gid, rawWord, action, reporter, now = Date.now()) {
  const word = String(rawWord ?? '').trim()
  const hit = resolve(gid, word)
  if (!hit) return { ok: false, reason: 'not-found' }
  const from = Number(hit.row.count) || 0
  const to = action?.abs != null ? action.abs : from + Number(action?.delta ?? 0)
  if (!Number.isInteger(to) || to < 0) {
    return { ok: false, reason: 'negative', name: hit.name, from }
  }
  const who = String(reporter ?? '').trim()
  const arcades = { ...arcadesOf(gid) }
  arcades[hit.name] = { ...hit.row, count: to, reporter: who || undefined, updatedAt: now }
  saveGroup(gid, arcades)
  return { ok: true, name: hit.name, from, to }
}

/** 本群机厅列表（插入序） @returns {Array<{name: string, row: ArcadeRow}>} */
export function listArcades(gid) {
  return Object.entries(arcadesOf(gid)).map(([name, row]) => ({ name, row }))
}

/* ---------------- 口语匹配与时间格式化 ---------------- */

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 本群口语匹配正则：^(?:名1|名2|别名…)(j|几|[-+]?\d+)$
 * 词表按**长度降序**拼接——机厅名可含数字，「机厅23」须优先解析为「机厅2」+上报3（若存在机厅2）。
 * @returns {RegExp | null} 本群无机厅时返回 null（调用方可零开销放行）
 */
export function buildMatchRegex(gid) {
  const key = String(gid)
  if (regexCache.has(key)) return regexCache.get(key)
  const words = []
  for (const [name, row] of Object.entries(arcadesOf(gid))) {
    words.push(name, ...(row.aliases || []))
  }
  let regex = null
  if (words.length) {
    words.sort((a, b) => b.length - a.length)
    regex = new RegExp(`^(?:${words.map(escapeRe).join('|')})(j|几|[-+]?\\d+)$`)
  }
  regexCache.set(key, regex)
  return regex
}

/** 绝对时间：今天 HH:mm / 今年 MM-DD HH:mm / 跨年 YYYY-MM-DD HH:mm */
export function formatAbsolute(ts, now = Date.now()) {
  const d = new Date(ts)
  const t = new Date(now)
  const pad2 = n => String(n).padStart(2, '0')
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const sameDay = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()
  if (sameDay) return hm
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
  return d.getFullYear() === t.getFullYear() ? md : `${d.getFullYear()}-${md}`
}

/** 相对时间：刚刚 / x分钟前 / x小时x分钟前 / x天x小时前（时钟偏移为负按 0 兜底） */
export function formatRelative(now, ts) {
  let sec = Math.floor((now - ts) / 1000)
  if (sec < 0) sec = 0
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) {
    const rest = min % 60
    return rest ? `${hour}小时${rest}分钟前` : `${hour}小时前`
  }
  const day = Math.floor(hour / 24)
  const rest = hour % 24
  return rest ? `${day}天${rest}小时前` : `${day}天前`
}
