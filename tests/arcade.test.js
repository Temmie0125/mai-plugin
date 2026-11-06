import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as arcade from '../lib/arcade.js'
import { readJson } from '../lib/jsonFile.js'
import { MaiArcade, MaiArcadeListen, queryText, reportText, listText } from '../apps/arcade.js'

// 宿主全局 logger 打桩（模块顶层捕获 global.logger；groupSwitch 同款）
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-plugin-arcade-'))
  arcade.setDataRoot(dir)
  arcade.load()
  return () => fs.rmSync(dir, { recursive: true, force: true })
})

function fakeInst(Cls) {
  const inst = new Cls()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')
  return { inst, replies }
}

const groupE = (msg, overrides = {}) => ({
  msg, isGroup: true, group_id: 111,
  sender: { card: '张三', nickname: 'z3', user_id: 42 },
  ...overrides,
})

/* ---------------- lib：创建 / 唯一性 / 别名 ---------------- */

test('create：默认 count 0；resolve 支持名称与别名', () => {
  assert.deepEqual(arcade.create(111, '机厅'), { ok: true, name: '机厅' })
  assert.deepEqual(arcade.addAlias(111, '机厅', 'jt'), { ok: true, name: '机厅', alias: 'jt' })
  assert.deepEqual(arcade.resolve(111, '机厅').row, { count: 0, aliases: ['jt'] })
  assert.equal(arcade.resolve(111, 'jt').name, '机厅')
  assert.equal(arcade.resolve(111, '不存在'), null)
  assert.equal(arcade.resolve(111, ''), null)
})

test('唯一性：名↔名、名↔别名、别名↔别名 群内互斥且带回占用者；跨群互不影响', () => {
  arcade.create(111, '机厅')
  arcade.addAlias(111, '机厅', 'jt')
  arcade.create(111, '二号厅')
  assert.deepEqual(arcade.create(111, '机厅'), { ok: false, reason: 'exists', holder: '机厅' })
  assert.deepEqual(arcade.create(111, 'jt'), { ok: false, reason: 'exists', holder: '机厅' }, '新名撞已有别名')
  assert.deepEqual(arcade.addAlias(111, '二号厅', 'jt'), { ok: false, reason: 'exists', holder: '机厅' }, '别名撞他人别名')
  assert.deepEqual(arcade.addAlias(111, '二号厅', '机厅'), { ok: false, reason: 'exists', holder: '机厅' }, '别名撞他人名')
  assert.equal(arcade.create(222, '机厅').ok, true, '其它群同名不受限')
})

test('create：名称校验（空/含->/超长/trim）', () => {
  assert.equal(arcade.create(111, '   ').reason, 'empty')
  assert.equal(arcade.create(111, 'a->b').reason, 'has-arrow')
  assert.equal(arcade.create(111, 'x'.repeat(25)).reason, 'too-long')
  assert.equal(arcade.create(111, '  机厅  ').name, '机厅')
})

test('remove：按别名删、级联别名、空表清群键', () => {
  arcade.create(111, '机厅')
  arcade.addAlias(111, '机厅', 'jt')
  assert.equal(arcade.remove(111, 'jt').name, '机厅', '可按别名删')
  assert.equal(arcade.resolve(111, '机厅'), null, '整厅已删')
  assert.deepEqual(arcade.remove(111, '机厅'), { ok: false, reason: 'not-found' })
})

test('addAlias/removeAlias：追加、缺别名、trim', () => {
  arcade.create(111, '机厅')
  assert.deepEqual(arcade.addAlias(111, '不存在', 'x'), { ok: false, reason: 'not-found' })
  assert.equal(arcade.addAlias(111, '机厅', '  jt  ').alias, 'jt')
  assert.equal(arcade.addAlias(111, '机厅', 'jt2').ok, true)
  assert.deepEqual(arcade.resolve(111, '机厅').row.aliases, ['jt', 'jt2'])
  assert.deepEqual(arcade.removeAlias(111, '机厅', '没设过'), { ok: false, reason: 'no-alias' })
  assert.deepEqual(arcade.removeAlias(111, '不存在', 'jt'), { ok: false, reason: 'not-found' })
  assert.equal(arcade.removeAlias(111, '机厅', 'jt').ok, true)
  assert.equal(arcade.resolve(111, 'jt'), null, '删除后别名即失效')
  assert.equal(arcade.resolve(111, 'jt2').name, '机厅')
})

/* ---------------- lib：上报 ---------------- */

test('applyReport：绝对/增减/归零；减到负拒绝且不落盘；上报者快照', () => {
  arcade.create(111, '机厅')
  const now = 1_700_000_000_000
  assert.deepEqual(arcade.applyReport(111, '机厅', { abs: 3 }, '张三', now), { ok: true, name: '机厅', from: 0, to: 3 })
  assert.deepEqual(arcade.applyReport(111, '机厅', { delta: 1 }, '李四', now + 1), { ok: true, name: '机厅', from: 3, to: 4 })
  assert.deepEqual(arcade.applyReport(111, '机厅', { delta: -2 }, '李四', now + 2), { ok: true, name: '机厅', from: 4, to: 2 })
  assert.deepEqual(
    arcade.applyReport(111, '机厅', { delta: -5 }, '李四', now + 3),
    { ok: false, reason: 'negative', name: '机厅', from: 2 },
  )
  assert.equal(arcade.resolve(111, '机厅').row.count, 2, '拒绝不落盘')
  assert.deepEqual(arcade.applyReport(111, '机厅', { abs: 0 }, '李四', now + 4), { ok: true, name: '机厅', from: 2, to: 0 })
  const row = arcade.resolve(111, '机厅').row
  assert.equal(row.reporter, '李四')
  assert.equal(row.updatedAt, now + 4)
  assert.deepEqual(arcade.applyReport(111, '查无此厅', { abs: 1 }, 'x'), { ok: false, reason: 'not-found' })
})

test('落盘：行级 read-merge-write——外部其它群一律保留', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-plugin-arcade-disk-'))
  arcade.setDataRoot(d)
  const file = path.join(d, 'arcade.json')
  fs.writeFileSync(file, JSON.stringify({ 999: { arcades: { 外部厅: { count: 9, aliases: [] } } } }))
  arcade.load()
  arcade.create(111, '机厅')
  const disk = readJson(file, {})
  assert.equal(disk['999'].arcades['外部厅'].count, 9, '外部群不被内存态回退')
  assert.equal(disk['111'].arcades['机厅'].count, 0)
  arcade.remove(111, '机厅')
  assert.equal(readJson(file, {})['999'].arcades['外部厅'].count, 9, '删除后写盘仍保留外部群')
})

/* ---------------- lib：口语正则与时间格式化 ---------------- */

test('buildMatchRegex：规格示例全命中；最长优先；元字符转义；空群为 null', () => {
  assert.equal(arcade.buildMatchRegex(111), null, '无机厅群零开销放行')
  arcade.create(111, '机厅')
  arcade.addAlias(111, '机厅', 'jt')
  arcade.create(111, '二号厅2')
  const re = arcade.buildMatchRegex(111)
  const pick = msg => {
    const m = msg.match(re)
    return m ? [msg.slice(0, msg.length - m[1].length), m[1]] : null
  }
  assert.deepEqual(pick('机厅j'), ['机厅', 'j'])
  assert.deepEqual(pick('机厅几'), ['机厅', '几'])
  assert.deepEqual(pick('jtj'), ['jt', 'j'])
  assert.deepEqual(pick('机厅3'), ['机厅', '3'])
  assert.deepEqual(pick('机厅+1'), ['机厅', '+1'])
  assert.deepEqual(pick('机厅-2'), ['机厅', '-2'])
  assert.deepEqual(pick('二号厅20'), ['二号厅2', '0'], '名含数字时长名优先')
  assert.deepEqual(pick('二号厅2j'), ['二号厅2', 'j'])
  assert.equal(pick('机厅'), null, '裸名称不触发')
  assert.equal(pick('机厅+'), null, '缺数字不触发')
  assert.equal(pick('今天去机厅'), null, '非后缀命中不触发')
  arcade.create(111, '厅(分店)')
  assert.ok(arcade.buildMatchRegex(111).test('厅(分店)j'), '正则元字符须转义')
})

test('formatRelative：各档位与时钟偏移兜底', () => {
  const now = Date.now()
  assert.equal(arcade.formatRelative(now, now), '刚刚')
  assert.equal(arcade.formatRelative(now, now - 59e3), '刚刚')
  assert.equal(arcade.formatRelative(now, now - 60e3), '1分钟前')
  assert.equal(arcade.formatRelative(now, now - 59 * 60e3), '59分钟前')
  assert.equal(arcade.formatRelative(now, now - 3600e3), '1小时前')
  assert.equal(arcade.formatRelative(now, now - (3600 + 5 * 60) * 1e3), '1小时5分钟前')
  assert.equal(arcade.formatRelative(now, now - 24 * 3600e3), '1天前')
  assert.equal(arcade.formatRelative(now, now - (24 * 3600 + 3 * 3600) * 1e3), '1天3小时前')
  assert.equal(arcade.formatRelative(now, now + 30e3), '刚刚', '时钟偏移为负按 0 兜底')
})

test('formatAbsolute：今天 / 今年 / 跨年', () => {
  const now = new Date(2026, 10, 6, 14, 30).getTime()
  assert.equal(arcade.formatAbsolute(new Date(2026, 10, 6, 14, 30).getTime(), now), '14:30')
  assert.equal(arcade.formatAbsolute(new Date(2026, 4, 1, 9, 5).getTime(), now), '05-01 09:05')
  assert.equal(arcade.formatAbsolute(new Date(2025, 0, 2, 8, 1).getTime(), now), '2025-01-02 08:01')
})

/* ---------------- 文案 ---------------- */

test('queryText：已上报含昵称与双时间；未上报给示例引导', () => {
  const now = new Date(2026, 10, 6, 15, 0).getTime()
  assert.equal(
    queryText('机厅', { count: 0, aliases: [] }, now),
    '「机厅」0人\n暂无上报记录（示例：机厅3）',
  )
  const ts = now - (2 * 3600 + 15 * 60) * 1e3
  assert.equal(
    queryText('机厅', { count: 3, reporter: '张三', updatedAt: ts }, now),
    '「机厅」3人\n由「张三」更新于：12:45（2小时15分钟前）',
  )
})

test('reportText：修改至 / 增加至 / 减少至', () => {
  assert.equal(reportText('机厅', 0, 3, null), '「机厅」人数由0修改至3')
  assert.equal(reportText('机厅', 3, 3, 0), '「机厅」人数由3修改至3', '±0 用修改至')
  assert.equal(reportText('机厅', 3, 4, 1), '「机厅」人数由3增加至4')
  assert.equal(reportText('机厅', 5, 3, -2), '「机厅」人数由5减少至3')
})

test('listText：空群引导与列表（人数/别名）', () => {
  assert.match(listText(111), /还没有机厅/)
  arcade.create(111, '机厅')
  arcade.addAlias(111, '机厅', 'jt')
  arcade.create(111, '二号厅')
  const text = listText(111)
  assert.match(text, /^本群机厅（2）：/)
  assert.match(text, /「机厅」0人（别名：jt）/)
  assert.match(text, /「二号厅」0人/)
})

/* ---------------- apps：管理命令 ---------------- */

test('MaiArcade：创建/重名/缺参必回执（含可选命令头与私聊守卫）', async () => {
  const { inst, replies } = fakeInst(MaiArcade)
  assert.equal(await inst.createArcade(groupE('#创建机厅 机厅')), true)
  assert.match(replies.at(-1), /机厅「机厅」已创建/)
  assert.equal(await inst.addAlias(groupE('#添加机厅别名 机厅->jt')), true)
  await inst.createArcade(groupE('#创建机厅 机厅'))
  assert.match(replies.at(-1), /本群已存在同名或同别名的机厅「机厅」/)
  await inst.createArcade(groupE('#创建机厅 jt'))
  assert.match(replies.at(-1), /已存在同名或同别名/, '新名撞已有别名也回执')
  await inst.createArcade(groupE('#创建机厅'))
  assert.match(replies.at(-1), /用法：#创建机厅/, '缺参回用法而非静默')
  await inst.createArcade(groupE('#mai 创建机厅 二号厅'))
  assert.match(replies.at(-1), /「二号厅」已创建/, '带命令头同可用')
  await inst.createArcade(groupE('#创建机厅 机厅A', { isGroup: false }))
  assert.match(replies.at(-1), /请在群聊中使用/)
})

test('MaiArcade：别名添加/删除/占用/缺箭头', async () => {
  const { inst, replies } = fakeInst(MaiArcade)
  arcade.create(111, '机厅')
  arcade.create(111, '二号厅')
  assert.equal(await inst.addAlias(groupE('#添加机厅别名 机厅->jt')), true)
  assert.match(replies.at(-1), /已为「机厅」添加别名「jt」/)
  await inst.addAlias(groupE('#添加机厅别名 二号厅->jt'))
  assert.match(replies.at(-1), /别名「jt」已被机厅「机厅」占用/)
  await inst.addAlias(groupE('#添加机厅别名 机厅jt'))
  assert.match(replies.at(-1), /用法：#添加机厅别名/, '缺 -> 回用法')
  await inst.addAlias(groupE('#添加机厅别名 不存在->x'))
  assert.match(replies.at(-1), /本群没有机厅「不存在」/)
  await inst.addAlias(groupE('#mai 添加机厅别名 机厅 -> jt2'))
  assert.match(replies.at(-1), /添加别名「jt2」/, '-> 两侧可带空格')
  assert.equal(await inst.removeAlias(groupE('#删除机厅别名 机厅->jt2')), true)
  assert.match(replies.at(-1), /已删除「机厅」的别名「jt2」/)
  await inst.removeAlias(groupE('#删除机厅别名 机厅->jt2'))
  assert.match(replies.at(-1), /「机厅」没有别名「jt2」/)
  await inst.removeAlias(groupE('#删除机厅别名'))
  assert.match(replies.at(-1), /用法：#删除机厅别名/, '缺参回用法而非静默')
})

test('MaiArcade：删除机厅（按名称或别名）与不存在回执', async () => {
  const { inst, replies } = fakeInst(MaiArcade)
  arcade.create(111, '机厅')
  arcade.addAlias(111, '机厅', 'jt')
  assert.equal(await inst.removeArcade(groupE('#删除机厅 jt')), true)
  assert.match(replies.at(-1), /已删除机厅「机厅」/)
  await inst.removeArcade(groupE('#删除机厅 机厅'))
  assert.match(replies.at(-1), /本群没有名为或别名为「机厅」的机厅/)
  await inst.removeArcade(groupE('#删除机厅'))
  assert.match(replies.at(-1), /用法：#删除机厅/, '缺参回用法而非静默')
})

test('MaiArcade：机厅列表', async () => {
  const { inst, replies } = fakeInst(MaiArcade)
  assert.equal(await inst.listArcades(groupE('#机厅列表')), true)
  assert.match(replies.at(-1), /还没有机厅/)
  arcade.create(111, '机厅')
  await inst.listArcades(groupE('#mai 机厅列表'))
  assert.match(replies.at(-1), /本群机厅（1）：/)
})

test('规则正则：管理命令形态互不误吞', () => {
  const inst = new MaiArcade()
  const regOf = fnc => new RegExp(inst.rule.find(r => r.fnc === fnc).reg)
  const create = regOf('createArcade')
  assert.ok(create.test('#创建机厅 机厅'))
  assert.ok(create.test('/创建机厅 机厅'))
  assert.ok(create.test('#mai 创建机厅 机厅'))
  assert.ok(create.test('#mai创建机厅 机厅'))
  assert.ok(!create.test('#创建机厅别名 x'), '不带空格的后缀命令不被吞')
  const remove = regOf('removeArcade')
  assert.ok(remove.test('#删除机厅 jt'))
  assert.ok(!remove.test('#删除机厅别名 机厅->jt'), '删除别名不被「删除机厅」吞')
  assert.ok(regOf('addAlias').test('#添加机厅别名 机厅->jt'))
  assert.ok(regOf('removeAlias').test('#删除机厅别名 机厅->jt'))
  assert.ok(regOf('listArcades').test('#机厅列表'))
  assert.ok(regOf('listArcades').test('#mai 机厅列表'))
})

/* ---------------- apps：口语兜底 ---------------- */

test('MaiArcadeListen：查询/上报全链路', async () => {
  arcade.create(111, '机厅')
  arcade.addAlias(111, '机厅', 'jt')
  const { inst, replies } = fakeInst(MaiArcadeListen)

  assert.equal(await inst.onMessage(groupE('机厅3')), true)
  assert.equal(replies.at(-1), '「机厅」人数由0修改至3')
  assert.equal(await inst.onMessage(groupE('机厅+1')), true)
  assert.equal(replies.at(-1), '「机厅」人数由3增加至4')
  assert.equal(await inst.onMessage(groupE('机厅-2')), true)
  assert.equal(replies.at(-1), '「机厅」人数由4减少至2')
  assert.equal(await inst.onMessage(groupE('机厅-5')), true)
  assert.match(replies.at(-1), /「机厅」当前仅2人，无法减少5/)

  assert.equal(await inst.onMessage(groupE('机厅j')), true)
  assert.match(replies.at(-1), /「机厅」2人/)
  assert.match(replies.at(-1), /由「张三」更新于：/)
  assert.match(replies.at(-1), /（刚刚）/)
  assert.equal(await inst.onMessage(groupE('jtj')), true, '别名查询')
  assert.match(replies.at(-1), /「机厅」2人/)
  assert.equal(await inst.onMessage(groupE('机厅几')), true, '「几」后缀查询')
  assert.match(replies.at(-1), /「机厅」2人/)
  assert.equal(replies.length, 7, '上述交互恰好各回一条')
})

test('MaiArcadeListen：未上报查询给示例；未命中一律静默放行', async () => {
  arcade.create(222, '新厅')
  const { inst, replies } = fakeInst(MaiArcadeListen)
  assert.equal(await inst.onMessage(groupE('新厅j', { group_id: 222 })), true)
  assert.match(replies.at(-1), /暂无上报记录（示例：新厅3）/)

  const before = replies.length
  assert.equal(await inst.onMessage(groupE('机厅3', { group_id: 999 })), false, '无机厅群')
  assert.equal(await inst.onMessage(groupE('今天去机厅吗', { group_id: 222 })), false, '无关文本')
  assert.equal(await inst.onMessage(groupE('新厅', { group_id: 222 })), false, '裸名称不触发')
  assert.equal(await inst.onMessage(groupE('新厅+', { group_id: 222 })), false, '缺数字')
  assert.equal(await inst.onMessage(groupE('新厅3', { isGroup: false })), false, '私聊')
  assert.equal(replies.length, before, '未命中不回复不吞聊天')
})
