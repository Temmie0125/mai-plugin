/**
 * 用户/群数据持久化（设计 §6.2/§6.3）
 * - data/user.json  ：用户绑定与主题表（源 user.db 单表 JSON 化）
 * - data/group.json ：群开关（猜歌/别名推送）
 * 启动一次性载入内存，变更即写；写前备份 .bak 防崩溃半写。
 *
 * 用户键 = 平台用户标识**原样字符串**（双协议兼容）：
 *   OneBot/QQ 号环境 → 纯数字串（如 '114514'），行内附 qqid: Number
 *   官方 QQBot/openid 环境 → openid 串（非纯数字），行内无 qqid（水鱼代查不可用，落雪全功能）
 *   ⚠️ 勿把 openid 当数字强转（NaN→null 会污染行键/行数据）
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

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
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
  for (const k of emptyJunk) delete userDb.users[k]

  for (const j of credRows) {
    const candidates = Object.keys(userDb.users)
      .filter(k => !junk.includes(k) && !carriesCreds(k))
    if (candidates.length === 1) {
      userDb.users[candidates[0]] = { ...userDb.users[candidates[0]], ...userDb.users[j] }
      delete userDb.users[j]
      writeJson(path.join(dataRoot, 'user.json'), userDb)
    } else {
      console.warn(`[mai-plugin] 无法自愈脏行「${j}」（候选 ${candidates.length} 个），保留待人工处理`)
    }
  }
}

/** 按用户键取用户记录（键=纯数字 QQ 串或 openid，无记录返回 undefined） */
export function getUser(key) {
  return userDb.users[String(key)]
}

/** 写入/更新用户记录（合并已有字段），立即落盘 */
export function updateUser(key, patch) {
  const k = String(key)
  const row = { ...(userDb.users[k] || {}), ...patch }
  if (/^\d+$/.test(k)) {
    row.qqid = Number(k)
  } else {
    // openid 键不带数字 qqid（历史 NaN 污染一并清除）
    delete row.qqid
  }
  userDb.users[k] = row
  writeJson(path.join(dataRoot, 'user.json'), userDb)
  return row
}

/** 取群设置（无记录返回默认全关） */
export function getGroup(groupId) {
  return groupDb[String(groupId)] || { guess: false, aliasPush: false }
}

/** 写入群设置，立即落盘 */
export function updateGroup(groupId, patch) {
  const key = String(groupId)
  groupDb[key] = { guess: false, aliasPush: false, ...(groupDb[key] || {}), ...patch }
  writeJson(path.join(dataRoot, 'group.json'), groupDb)
  return groupDb[key]
}

/** 测试/排障用：当前内存态 */
export function dump() {
  return { userDb, groupDb }
}
