/**
 * user.db（源 NoneBot SQLModel）→ data/user.json 迁移（设计 §6.2 迁移脚本）
 * - 映射：枚举 name 列（DIVINGFISH/LXNS、PRISM_PLUS/CIRCLE）→ JS 短名（df/lxns、prism_plus/circle）
 * - 只补空字段，绝不覆盖已有绑定（幂等可重跑）；跳过 qqid 非整数行
 * - ⚠️ 勿在 BOT 运行中执行（与 lib/database.js 内存态/落盘冲突）
 *
 * 用法：node plugins/mai-plugin/scripts/migrate-userdb.mjs [旧库路径] [目标 user.json]
 * 默认读 resources/static/data/user.db → data/user.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ENUM_TO_JS = {
  service: { DIVINGFISH: 'df', LXNS: 'lxns' },
  theme: { PRISM_PLUS: 'prism_plus', CIRCLE: 'circle' },
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

/** 旧库行 → 可写补丁（枚举 name→短名；无法映射的字段忽略） */
function rowToPatch(row) {
  const patch = {}
  const mapEnum = (col, table) => {
    if (row[col] == null || row[col] === '') return
    const js = table[String(row[col]).toUpperCase()]
    if (js !== undefined) patch[col] = js
  }
  mapEnum('service', ENUM_TO_JS.service)
  mapEnum('theme', ENUM_TO_JS.theme)
  if (row.friend_code != null) patch.friendCode = Number(row.friend_code)
  if (row.access_token) patch.accessToken = String(row.access_token)
  if (row.refresh_token) patch.refreshToken = String(row.refresh_token)
  return patch
}

/**
 * 迁移主函数（幂等：目标已存在非空字段一律不动）
 * @returns {{imported: number, updated: number, skipped: string[]}}
 */
export function migrateUserDb({ dbPath, userJsonPath }) {
  const db = new DatabaseSync(dbPath)
  let rows
  try {
    rows = db.prepare('SELECT * FROM user').all()
  } finally {
    db.close()
  }

  const userDb = readJson(userJsonPath, { users: {} })
  if (!userDb.users || typeof userDb.users !== 'object') {
    throw new Error(`目标 ${userJsonPath} 结构异常：缺少 users 对象`)
  }

  const stats = { imported: 0, updated: 0, skipped: [] }
  for (const row of rows) {
    const qqid = Number(row.qqid)
    if (!Number.isInteger(qqid) || qqid <= 0) {
      stats.skipped.push(String(row.qqid))
      continue
    }
    const key = String(qqid)
    const target = userDb.users[key] || { qqid }
    const patch = rowToPatch(row)
    if (!Object.keys(patch).length) continue

    let changed = false
    for (const [k, v] of Object.entries(patch)) {
      const cur = target[k]
      if (cur == null || cur === '' || (k === 'qqid' && cur == null)) {
        target[k] = v
        changed = true
      }
    }
    if (!userDb.users[key]) {
      userDb.users[key] = target
      stats.imported++
    } else if (changed) {
      stats.updated++
    }
  }

  if (stats.imported || stats.updated) {
    fs.mkdirSync(path.dirname(userJsonPath), { recursive: true })
    if (fs.existsSync(userJsonPath)) fs.copyFileSync(userJsonPath, `${userJsonPath}.bak`)
    fs.writeFileSync(userJsonPath, JSON.stringify(userDb, null, 2))
  }
  return stats
}

// CLI 主入口（默认路径）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dbPath = process.argv[2] || path.join(pluginRoot, 'resources', 'static', 'data', 'user.db')
  const userJsonPath = process.argv[3] || path.join(pluginRoot, 'data', 'user.json')
  const stats = migrateUserDb({ dbPath, userJsonPath })
  console.log(`[migrate-userdb] 完成：新建 ${stats.imported} · 补写 ${stats.updated} · 跳过 ${stats.skipped.length}`)
  if (stats.skipped.length) console.log(`[migrate-userdb] 跳过非整数 qqid：${stats.skipped.join(', ')}`)
}
