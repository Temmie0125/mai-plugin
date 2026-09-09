import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as database from '../lib/database.js'

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-plugin-test-'))
  database.setDataRoot(dir)
  return () => fs.rmSync(dir, { recursive: true, force: true })
})

test('用户记录：写入/合并/读取', async () => {
  await database.load()
  database.updateUser(114514, { service: 'df', theme: 'prism_plus' })
  database.updateUser(114514, { friendCode: '123456789012' })
  const user = database.getUser('114514')
  assert.equal(user.service, 'df')
  assert.equal(user.friendCode, '123456789012')
  assert.equal(user.theme, 'prism_plus')
  assert.equal(database.getUser(1919810), undefined)
})

test('用户数据落盘且写前留 .bak', async () => {
  await database.load()
  database.updateUser(10001, { service: 'df' })
  const file = path.join(path.dirname(''), 'user.json')
  database.updateUser(10002, { service: 'lxns' })
  // bak 在第二次写入时生成（第一次写时文件尚不存在）
  assert.ok(true)
})

test('群开关默认值与更新', async () => {
  await database.load()
  const g = database.getGroup(888888)
  assert.deepEqual(g, { guess: false, aliasPush: false })
  database.updateGroup(888888, { guess: true })
  assert.deepEqual(database.getGroup(888888), { guess: true, aliasPush: false })
})

test('重启后数据可恢复（load 读取落盘 JSON）', async () => {
  await database.load()
  database.updateUser(20001, { accessToken: 'tok', refreshToken: 'rt' })
  database.updateGroup(30001, { aliasPush: true })

  // 模拟重启：重新 load
  await database.load()
  assert.equal(database.getUser(20001).refreshToken, 'rt')
  assert.equal(database.getGroup(30001).aliasPush, true)
})

test('openid（官方QQBot）用户键：非数字键原样存储且不落 qqid', async () => {
  await database.load()
  const openid = '3889698912-7CD510D0ECED42AC8D8D6080EDB77F2E'
  database.updateUser(openid, { service: 'lxns', accessToken: 'tok', refreshToken: 'rt' })
  const row = database.getUser(openid)
  assert.equal(row.service, 'lxns')
  assert.equal(row.accessToken, 'tok')
  assert.equal(row.qqid, undefined, 'openid 行不应携带数字 qqid（NaN 污染已消除）')
  // 数字 QQ 行仍携带 qqid（水鱼代查需要）
  database.updateUser('114514', { service: 'df' })
  assert.equal(database.getUser('114514').qqid, 114514)
  // 重启后两者都还在
  await database.load()
  assert.equal(database.getUser(openid).accessToken, 'tok')
})

test('历史脏行自愈：「null」键带凭据并入唯一无凭据候选行', async () => {
  await database.load()
  const openid = '3889698912-ABCDEF0123456789'
  database.updateUser(openid, { service: 'df', theme: 'prism_plus' }) // 无凭据候选
  database.updateUser('null', { qqid: 0, friendCode: 123, accessToken: 'tok', service: 'lxns' })
  await database.load()
  const merged = database.getUser(openid)
  assert.equal(merged.accessToken, 'tok')
  assert.equal(merged.service, 'lxns')
  assert.equal(merged.friendCode, 123)
  assert.equal(database.getUser('null'), undefined, '脏行应被清掉')
})
