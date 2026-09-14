/**
 * 成绩缓存层单测（设计《拟合b50实现设计.md》§3 / §9）
 *
 * 手法：`setDataRoot(临时目录)` 后走真实落盘（**绝不碰真机 data/**）。
 * 本模块无内存态，故 setDataRoot 后无需 load（与 lib/database.js 的差异）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  setDataRoot, cacheFileName, localToday,
  readB50, writeB50, readRecords, writeRecords,
  isFresh, isServiceMatch, clearUserCache, CACHE_VERSION,
} from '../lib/scoreCache.js'

/** 每个用例独立临时目录 */
function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-scorecache-'))
  setDataRoot(dir)
  return dir
}

const USER = { key: '114514', service: 'lxns' }
const PLAYER = { name: 'テスト', rating: 15000 }
const BEST50 = { sd_total: 12000, dx_total: 3000, sd: [{ song_id: 1 }], dx: [{ song_id: 2 }] }
const RECORDS = [{ song_id: 1, level_index: 3, achievements: 100.5 }]

test('roundtrip：write → read 保真，且戳记齐全', () => {
  const dir = tmpRoot()
  writeB50(USER, PLAYER, BEST50)
  const cache = readB50(USER.key)
  assert.equal(cache.v, CACHE_VERSION)
  assert.equal(cache.key, '114514')
  assert.equal(cache.service, 'lxns')
  assert.equal(cache.date, localToday())
  assert.ok(Number.isInteger(cache.fetchedAt) && cache.fetchedAt > 0)
  assert.deepEqual(cache.player, PLAYER)
  assert.deepEqual(cache.best50, BEST50)
  assert.ok(fs.existsSync(path.join(dir, 'b50', '114514.json')))
  assert.ok(!fs.existsSync(path.join(dir, 'b50', '114514.json.tmp')), '原子写不应残留 .tmp')
})

test('roundtrip：records 走独立目录，与 b50 互不干扰', () => {
  const dir = tmpRoot()
  writeRecords(USER, RECORDS)
  assert.deepEqual(readRecords(USER.key).records, RECORDS)
  assert.equal(readB50(USER.key), null, '只写了 records 时不应读到 b50')
  assert.ok(fs.existsSync(path.join(dir, 'records', '114514.json')))
  assert.ok(!fs.existsSync(path.join(dir, 'b50', '114514.json')))
})

test('service 戳：取 effectiveService（行内缺失时按凭据兜底）', () => {
  tmpRoot()
  // service 未写、但有落雪凭据 → effectiveService 判 lxns（lib/user.js:64 语义）
  writeRecords({ key: 'a1', accessToken: 'tok' }, RECORDS)
  assert.equal(readRecords('a1').service, 'lxns')
  writeRecords({ key: 'a2' }, RECORDS)
  assert.equal(readRecords('a2').service, 'df', '无凭据无 service → df')
})

test('isServiceMatch：同源即可用，不看日期（b50 的读取门槛）', () => {
  tmpRoot()
  const stale = { service: 'lxns', date: '2000-01-01' }
  assert.equal(isServiceMatch(stale, 'lxns'), true, '旧日期仍算匹配（D4 不限时长）')
  assert.equal(isServiceMatch(stale, 'df'), false, '异构数据源不匹配')
  assert.equal(isServiceMatch(null, 'lxns'), false)
  assert.equal(isServiceMatch(undefined, 'lxns'), false)
})

test('isFresh：日期边界——同日 fresh、隔日不 fresh（注入口 now）', () => {
  const cache = { service: 'lxns', date: '2026-09-14' }
  const sameDay = new Date(2026, 8, 14, 23, 59, 59)
  const nextDay = new Date(2026, 8, 15, 0, 0, 1)
  assert.equal(isFresh(cache, 'lxns', sameDay), true)
  assert.equal(isFresh(cache, 'lxns', nextDay), false, '跨本地日即过期（每日首次策略）')
  // 跨日判定与时钟时刻无关：同一天的 00:00 与 23:59 等价
  assert.equal(isFresh(cache, 'lxns', new Date(2026, 8, 14, 0, 0, 0)), true)
})

test('isFresh：数据源切换即过期（D10 不删缓存文件的前提）', () => {
  const cache = { service: 'df', date: localToday() }
  assert.equal(isFresh(cache, 'df'), true, '同日同源')
  assert.equal(isFresh(cache, 'lxns'), false, '换源后旧缓存作废')
  assert.equal(isFresh(null, 'df'), false)
})

test('cacheFileName：Windows 非法字符转义（encodeURIComponent 不转义 * ! \' ( )）', () => {
  assert.equal(cacheFileName('114514'), '114514')
  assert.equal(cacheFileName('a*b'), 'a%2Ab')
  assert.equal(cacheFileName("a'b"), 'a%27b')
  assert.equal(cacheFileName('a(b)c'), 'a%28b%29c')
  assert.equal(cacheFileName('a!b'), 'a%21b')
  // encodeURIComponent 自身已覆盖的字符（路径分隔、查询符、Windows 保留符）
  for (const [raw, want] of [['a/b', 'a%2Fb'], ['a\\b', 'a%5Cb'], ['a:b', 'a%3Ab'],
    ['a?b', 'a%3Fb'], ['a"b', 'a%22b'], ['a<b', 'a%3Cb'], ['a>b', 'a%3Eb'], ['a|b', 'a%7Cb']]) {
    assert.equal(cacheFileName(raw), want, `应转义：${raw}`)
  }
  // 数字键与 openid 键（openid 含 - _ . 等安全字符，原样保留）
  assert.equal(cacheFileName(114514), '114514')
  const openid = 'A1B2-c3_d.e~f'
  assert.equal(cacheFileName(openid), openid)
})

test('cacheFileName 转义后确实能落盘（含 * 的假想键）', () => {
  const dir = tmpRoot()
  const key = 'weird*key'
  writeB50({ key, service: 'df' }, PLAYER, BEST50)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'b50')), ['weird%2Akey.json'])
  assert.equal(readB50(key).key, key, '读回时键原样保留')
})

test('损坏 / 空白 / 版本不符 / 缺失 → 一律未命中', () => {
  const dir = tmpRoot()
  const file = path.join(dir, 'b50', 'x.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })

  assert.equal(readB50('x'), null, '文件不存在')

  fs.writeFileSync(file, '{ 这不是 JSON')
  assert.equal(readB50('x'), null, '截断/损坏')

  fs.writeFileSync(file, '   ')
  assert.equal(readB50('x'), null, '空白')

  fs.writeFileSync(file, JSON.stringify({ v: CACHE_VERSION + 1, service: 'df' }))
  assert.equal(readB50('x'), null, '版本不符按未命中处理')

  fs.writeFileSync(file, JSON.stringify({ service: 'df' }))
  assert.equal(readB50('x'), null, '无 v 字段')
})

test('clearUserCache：双文件尽删且幂等', () => {
  const dir = tmpRoot()
  writeB50(USER, PLAYER, BEST50)
  writeRecords(USER, RECORDS)
  clearUserCache(USER.key)
  assert.equal(readB50(USER.key), null)
  assert.equal(readRecords(USER.key), null)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'b50')), [])
  assert.deepEqual(fs.readdirSync(path.join(dir, 'records')), [])
  assert.doesNotThrow(() => clearUserCache(USER.key), '对不存在的键应幂等（force）')
})

test('localToday：本地时区而非 UTC', () => {
  // 本地 2026-09-14 00:30 —— 若按 UTC 会算成 09-13（东八区 UTC+8 的 前一日 16:30）
  assert.equal(localToday(new Date(2026, 8, 14, 0, 30)), '2026-09-14')
  assert.equal(localToday(new Date(2026, 0, 1, 0, 0)), '2026-01-01')
  assert.equal(localToday(new Date(2026, 11, 31, 23, 59)), '2026-12-31')
})
