/**
 * 用户/群数据持久化（设计 §6.2/§6.3）
 * - data/user.json  ：用户绑定与主题表（源 user.db 单表 JSON 化）
 * - data/group.json ：群开关（猜歌/别名推送）
 * 启动一次性载入内存，变更即写；写前备份 .bak 防崩溃半写。
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
  groupDb = readJson(path.join(dataRoot, 'group.json'), {})
}

/** 按 qq 号取用户记录（无记录返回 undefined） */
export function getUser(qqid) {
  return userDb.users[String(qqid)]
}

/** 写入/更新用户记录（合并已有字段），立即落盘 */
export function updateUser(qqid, patch) {
  const key = String(qqid)
  userDb.users[key] = { qqid: Number(qqid), ...(userDb.users[key] || {}), ...patch }
  writeJson(path.join(dataRoot, 'user.json'), userDb)
  return userDb.users[key]
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
