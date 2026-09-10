/**
 * 用户/群数据持久化（设计 §6.2/§6.3）
 * - data/user.json  ：用户绑定与主题表（源 user.db 单表 JSON 化）
 * - data/group.json ：群开关（猜歌/别名推送）
 * 启动一次性载入内存；变更即写。
 *
 * ⚠️ 写盘安全（P2 事故修复）：早期实现用「内存整库快照」覆盖落盘——
 *    任何以旧快照 load 过的进程/调试脚本，写入一次即把期间真机新增的
 *    lxns 凭据（401 刷新轮换后的新 refresh_token）回退成旧值，服务端已轮换
 *    → 旧值失效 = 凭据永久丢失（连 .bak 也被逐次覆盖）。
 *    现改为：
 *    1) 行级 read-merge-write：写前重读磁盘，磁盘为基底；本次键以
 *       「磁盘行 ← 内存行 ← patch」顺序合并，磁盘其它键一律保留（尊重外部进程/删除）；
 *    2) 凭据空值保护：accessToken / refreshToken / friendCode 的空值不得覆盖非空值；
 *    3) 时间戳备份轮转：写前备份 user.json.<yyyymmddHHmmss>.bak（保留最近 10 份）。
 *
 * 用户键 = 平台用户标识**原样字符串**（双协议兼容）：
 *   OneBot/QQ 号环境 → 纯数字串（如 '114514'），行内附 qqid: Number
 *   官方 QQBot/openid 环境 → openid 串（非纯数字），行内无 qqid（水鱼代查不可用，落雪全功能）
 *   ⚠️ 勿把 openid 当数字强转（NaN→null 会污染行键/行数据）
 * 测试/调试规范：**必须**先 setDataRoot(临时目录)，严禁对真机 data/ 直接读写。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot } from './path.js'

let dataRoot = path.join(pluginRoot, 'data')

/** 测试注入数据目录（生产勿用） */
export function setDataRoot(dir) {
  dataRoot = dir
}

/** @type {{ users: Record<string, any> }} */
let userDb = { users: {} }
/** @type {Record<string, {guess?: boolean, aliasPush?: boolean}>} */
let groupDb = {}

/** 凭据字段：空值不得覆盖非空（防旧快照回退） */
const CRED_FIELDS = ['accessToken', 'refreshToken', 'friendCode']

const BACKUP_KEEP = 10

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

/** 写前时间戳备份 + 轮转（保留最近 BACKUP_KEEP 份） */
function backupFile(file) {
  if (!fs.existsSync(file)) return
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  fs.copyFileSync(file, `${file}.${stamp}.bak`)
  const dir = path.dirname(file)
  const prefix = `${path.basename(file)}.`
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.bak'))
    .sort()
  for (const f of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
    fs.rmSync(path.join(dir, f), { force: true })
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  backupFile(file)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

/** 空值保护合并：newRow 中凭据为空串/undefined 时回填 base 的非空值 */
function mergeRow(base, ...rows) {
  const merged = Object.assign({}, base, ...rows)
  for (const f of CRED_FIELDS) {
    if (merged[f] == null || merged[f] === '') {
      const fallback = rows.find(r => r && r[f] != null && r[f] !== '')?.[f]
        ?? (base[f] != null && base[f] !== '' ? base[f] : undefined)
      if (fallback !== undefined) merged[f] = fallback
      else delete merged[f]
    }
  }
  return merged
}

/**
 * userDb 落盘：**以磁盘为全集**（外部新增/删除一律尊重），仅本次键以
 * 「磁盘行 ← 内存行」合并；显式删除键（自愈场景）经 deletedKeys 传递。
 */
function persistUsers(changedKey = null, deletedKeys = [], deletedFields = []) {
  const file = path.join(dataRoot, 'user.json')
  const diskUsers = readJson(file, { users: {} }).users || {}
  const mergedUsers = { ...diskUsers }
  if (changedKey != null) {
    const k = String(changedKey)
    mergedUsers[k] = mergeRow(diskUsers[k] || {}, userDb.users[k] || {})
    // openid 键的 qqid 以内存为准（支持 #mai bind qq 显式补充与清除，勿让磁盘旧值回带）
    if (!/^\d+$/.test(k)) {
      const memQq = userDb.users[k]?.qqid
      if (Number.isInteger(memQq) && memQq > 0) mergedUsers[k].qqid = memQq
      else delete mergedUsers[k].qqid
    }
    // 显式清空字段（#mai unbind：凭据空值保护在此让位于用户主动解绑）
    for (const f of deletedFields) delete mergedUsers[k][f]
  }
  for (const d of deletedKeys) delete mergedUsers[String(d)]
  userDb.users = mergedUsers
  writeJson(file, { users: mergedUsers })
}

/** 启动载入（index.js 顶层 await 调用一次） */
export async function load() {
  fs.mkdirSync(dataRoot, { recursive: true })
  userDb = readJson(path.join(dataRoot, 'user.json'), { users: {} })
  if (!userDb.users) userDb.users = {}
  repairLegacyRows()
  groupDb = readJson(path.join(dataRoot, 'group.json'), {})
}

/**
 * 历史遗留行自愈（旧版把 openid 强转数字产生 NaN→'null' 键的脏行）：
 * - 带凭据的 'null'/'undefined'/'NaN' 行 → 并入唯一的无凭据候选行（避免丢失真实绑定）
 * - 其余空脏行直接清除
 */
function repairLegacyRows() {
  const junk = ['null', 'undefined', 'NaN']
  const junkKeys = junk.filter(k => userDb.users[k] && Object.keys(userDb.users[k]).length > 1)
  if (!junkKeys.length) return

  const carriesCreds = k => Boolean(userDb.users[k]?.accessToken || userDb.users[k]?.friendCode)
  const credRows = junkKeys.filter(carriesCreds)
  const emptyJunk = junkKeys.filter(k => !carriesCreds(k))
  const deleted = [...emptyJunk]
  for (const k of emptyJunk) delete userDb.users[k]

  let merged = null
  for (const j of credRows) {
    const candidates = Object.keys(userDb.users)
      .filter(k => !junk.includes(k) && !carriesCreds(k))
    if (candidates.length === 1) {
      const target = candidates[0]
      userDb.users[target] = mergeRow(userDb.users[target], userDb.users[j])
      delete userDb.users[j]
      deleted.push(j)
      merged = target
    } else {
      console.warn(`[mai-plugin] 无法自愈脏行「${j}」（候选 ${candidates.length} 个），保留待人工处理`)
    }
  }
  if (deleted.length) persistUsers(merged, deleted)
}

/** 按用户键取用户记录（键=纯数字 QQ 串或 openid，无记录返回 undefined） */
export function getUser(key) {
  return userDb.users[String(key)]
}

/** 写入/更新用户记录（合并已有字段，行级 read-merge-write 落盘） */
export function updateUser(key, patch) {
  const k = String(key)
  const row = { ...(userDb.users[k] || {}), ...patch }
  if (/^\d+$/.test(k)) {
    row.qqid = Number(k)
  } else if (Number.isInteger(patch?.qqid) && patch.qqid > 0) {
    // openid 键：允许用户主动补充游戏 QQ（#mai bind qq），显式数字保留
    row.qqid = patch.qqid
  } else {
    // openid 键未显式提供：不带数字 qqid（历史 NaN 污染与显式清除一并落空）
    delete row.qqid
  }
  userDb.users[k] = row
  persistUsers(k)
  return userDb.users[k]
}

/**
 * 显式清空指定字段（绕开凭据空值保护；供 #mai unbind 使用）
 * @param {string|number} key 用户键
 * @param {string[]} fields 要删除的字段
 */
export function clearUserFields(key, fields) {
  const k = String(key)
  const row = { ...(userDb.users[k] || {}) }
  for (const f of fields) delete row[f]
  userDb.users[k] = row
  persistUsers(k, [], fields)
  return userDb.users[k]
}

/** 取群设置（无记录返回默认全关） */
export function getGroup(groupId) {
  return groupDb[String(groupId)] || { guess: false, aliasPush: false }
}

/** 写入群设置，立即落盘（同款行级合并，磁盘其它群保留） */
export function updateGroup(groupId, patch) {
  const key = String(groupId)
  const file = path.join(dataRoot, 'group.json')
  const disk = readJson(file, {})
  const merged = { ...groupDb, ...disk }
  merged[key] = { guess: false, aliasPush: false, ...(disk[key] || groupDb[key] || {}), ...patch }
  groupDb = merged
  writeJson(file, merged)
  return groupDb[key]
}

/** 测试/排障用：当前内存态 */
export function dump() {
  return { userDb, groupDb }
}
