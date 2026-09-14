/**
 * 玩家成绩缓存（b50 + 全量成绩）——纯存储 + 新鲜度策略，零网络、零模块级可变状态
 * （设计《拟合b50实现设计.md》§3 二稿）
 *
 * 分层：client → merge → handler → 本模块。网络编排一律留在 lib/handler.js，
 * 本模块只做「落盘 / 读盘 / 判定新鲜度」三件事。
 *
 * ⚠️ 维护须知（设计 §3.5 / D17）——两个 write* 的调用方各自**只有一个**：
 *
 *   writeB50     ← 仅 handler.getBest50WithCache。
 *                  **禁止**被任何「带限定条件的 b50 变体」调用：AP50 / FC50 / FC+50 /
 *                  FDX50 / 随心配b50 等经 lxnsToBest50 转换后与真实 B50 **形状完全一致**
 *                  （/bests 与 /bests/ap 同形态，totals 亦各自自洽），写进缓存后
 *                  事后无法从内容分辨。AP50 已经踩过一次，且是静默的。
 *                  变体必须走 getBest50(user, {...}) —— 该函数不接受选项 ⇒ 结构性不可达本写点。
 *
 *   writeRecords ← 仅 handler.getPlayerResultCached，且只传**无 version 的全量**结果
 *                  （version !== null 时是 df 轻接口的版本过滤结果，属变体数据）。
 *
 * 不变量由 tests/scoreWriteGuard.test.js 锁定：**该测试报错时先修架构，再改测试**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot } from './path.js'
import { readJson, writeJsonAtomic } from './jsonFile.js'
import { effectiveService } from './user.js'

/** 缓存 schema 版本（结构变更时递增，读到旧版按未命中处理即可） */
export const CACHE_VERSION = 1

/** 缓存根目录（生产 = <pluginRoot>/data/score；测试用 setDataRoot 注入） */
let dataRoot = path.join(pluginRoot, 'data', 'score')

/**
 * 测试注入数据目录（生产勿用；与 `lib/database.js:setDataRoot` 同范式）
 * 注入后文件落在 `<dir>/b50/…` 与 `<dir>/records/…`。
 * ⚠️ 本模块**没有内存态**，故只换目录即可，无需像 database 那样再 load 一次。
 * @param {string} dir
 */
export function setDataRoot(dir) {
  dataRoot = dir
}

/**
 * 用户键 → 文件名（防御性转义）
 *
 * `encodeURIComponent` 已转义 Windows 非法字符中的 `\ / : ? " < > |`，
 * 但**不转义** `* ! ' ( )`——其中 `*` 在 Windows 上是非法文件名，故再补一遍。
 * （用户键实际只有纯数字 QQ 串与 openid 两类，此处是纵深防御。）
 * @param {string|number} userKey
 */
export function cacheFileName(userKey) {
  return encodeURIComponent(String(userKey))
    .replace(/[*!'()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** 本地时区 YYYY-MM-DD（新鲜度按**本地日**判定，不按 UTC） */
export function localToday(now = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

function fileOf(kind, userKey) {
  return path.join(dataRoot, kind, `${cacheFileName(userKey)}.json`)
}

/**
 * 读取 B50 缓存（**不限时长**：图鉴场景旧值亦可用的判定见 isServiceMatch）
 * @returns {{v:number,key:string,service:string,date:string,fetchedAt:number,player:object,best50:object}|null}
 *   缺失 / 损坏 / 版本不符一律 null（= 未命中）
 */
export function readB50(userKey) {
  return readCache(fileOf('b50', userKey))
}

/** 读取全量成绩缓存（新鲜度判定见 isFresh） */
export function readRecords(userKey) {
  return readCache(fileOf('records', userKey))
}

function readCache(file) {
  const data = readJson(file)
  if (!data || typeof data !== 'object' || data.v !== CACHE_VERSION) return null
  return data
}

/**
 * 写入 B50 缓存（戳 service / date）
 * @param {object} user user.json 行（可取 key 字段的对象即可）
 * @param {object} player Player 领域形态
 * @param {object} best50 Best50 领域形态
 */
export function writeB50(user, player, best50) {
  const key = String(user?.key ?? '')
  writeJsonAtomic(fileOf('b50', key), {
    v: CACHE_VERSION,
    key,
    service: effectiveService(user),
    date: localToday(),
    fetchedAt: Date.now(),
    player,
    best50,
  }, { indent: 0 })
}

/**
 * 写入全量成绩缓存（戳 service / date）
 * ⚠️ 只允许传**无 version 的全量**结果，见文件头维护须知。
 * @param {object} user
 * @param {Array} records PlayedResult[]
 */
export function writeRecords(user, records) {
  const key = String(user?.key ?? '')
  writeJsonAtomic(fileOf('records', key), {
    v: CACHE_VERSION,
    key,
    service: effectiveService(user),
    date: localToday(),
    fetchedAt: Date.now(),
    records,
  }, { indent: 0 })
}

/**
 * 「每日首次」新鲜度（**records 唯一使用方**；b50 不适用，见下）
 *
 * 为什么带 service：数据源切换（`#mai source`）后旧缓存是另一套口径的成绩，
 * 必须整份作废重拉 —— 这也是解绑时**不删缓存文件**（D10）的前提：
 * 戳记本身就是失效判据，无需在解绑路径上做删除。
 *
 * ⚠️ b50 缓存刻意**不用**本函数：b50 的写穿透是无条件的（每次真实 B50 拉取都写），
 *    读取门槛是 isServiceMatch（不限时长，D4）。
 */
export function isFresh(cache, service, now = new Date()) {
  return isServiceMatch(cache, service) && cache.date === localToday(now)
}

/**
 * 仅判定数据源是否匹配（**b50 的读取门槛**：同源旧值即可用，D4）
 * @param {object|null} cache
 * @param {string} service effectiveService 的值（'df' | 'lxns'）
 */
export function isServiceMatch(cache, service) {
  return cache != null && cache.service === service
}

/**
 * 删除某用户的全部缓存（双文件尽删）
 * 本期**无调用方**（预留）：解绑不删缓存（D10，靠 service 戳自然过期），
 * 保留此函数供将来「用户主动清理本地数据」类命令使用。
 */
export function clearUserCache(userKey) {
  for (const kind of ['b50', 'records']) {
    fs.rmSync(fileOf(kind, userKey), { force: true })
  }
}
