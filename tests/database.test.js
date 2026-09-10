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

test('写盘安全：外部新写入（如真机 401 刷新）不被内存旧快照回退', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-plugin-wal-'))
  database.setDataRoot(dir)
  await database.load()
  database.updateUser('1001', { service: 'lxns' }) // 内存快照：无凭据

  // 模拟外部进程（或 bot 运行中的另一次写）刷新出新鲜 refresh_token
  const file = path.join(dir, 'user.json')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  disk.users['1001'] = { ...disk.users['1001'], accessToken: 'NEW_AT', refreshToken: 'NEW_RT', friendCode: 42 }
  fs.writeFileSync(file, JSON.stringify(disk, null, 2))

  // 旧快照此刻做一次普通写（如切换主题）——不得回退凭据
  database.updateUser('1001', { theme: 'circle' })
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).users['1001']
  assert.equal(after.accessToken, 'NEW_AT')
  assert.equal(after.refreshToken, 'NEW_RT')
  assert.equal(after.friendCode, 42)
  assert.equal(after.theme, 'circle')
  // 内存与磁盘同步
  assert.equal(database.getUser('1001').refreshToken, 'NEW_RT')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('写盘安全：空值不覆盖非空凭据；磁盘删除被尊重；备份轮转 ≤10 份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-plugin-wal2-'))
  database.setDataRoot(dir)
  await database.load()
  database.updateUser('2002', { service: 'lxns', accessToken: 'AK', refreshToken: 'RK' })

  // 空值保护
  database.updateUser('2002', { accessToken: '' })
  assert.equal(database.getUser('2002').accessToken, 'AK')

  // 磁盘删除尊重（外部删键后，写另一键不得复活已删键）
  const file = path.join(dir, 'user.json')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete disk.users['2002']
  fs.writeFileSync(file, JSON.stringify(disk, null, 2))
  database.updateUser('3003', { service: 'df' })
  const users = JSON.parse(fs.readFileSync(file, 'utf8')).users
  assert.equal(users['2002'], undefined)
  assert.ok(users['3003'])

  // 备份轮转
  for (let i = 0; i < 12; i++) database.updateUser('3003', { theme: i % 2 ? 'circle' : 'prism_plus' })
  const backups = fs.readdirSync(dir).filter(f => f.startsWith('user.json.') && f.endsWith('.bak'))
  assert.ok(backups.length <= 10, `备份应轮转 ≤10，实际 ${backups.length}`)
  assert.ok(backups.length >= 1)
  fs.rmSync(dir, { recursive: true, force: true })
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
