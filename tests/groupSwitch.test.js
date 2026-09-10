import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as database from '../lib/database.js'
import { MaiPush, getAllGroups } from '../apps/push.js'

// 宿主全局 logger 打桩（service 模块顶层捕获 global.logger；冒烟脚本同款）
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-plugin-group-'))
  database.setDataRoot(dir)
  return () => fs.rmSync(dir, { recursive: true, force: true })
})

/** 假宿主 Bot：adapterBots = Bot[uin]（实取），caches = Bot.bots[uin].gl（缓存） */
function makeBot({ uins = [], adapterBots = {}, caches = {} } = {}) {
  const bot = { uin: [...uins], bots: {} }
  for (const [uin, ids] of Object.entries(caches)) {
    bot.bots[uin] = { gl: new Map(ids.map(id => [id, { group_id: id }])) }
  }
  for (const [uin, impl] of Object.entries(adapterBots)) bot[uin] = impl
  return bot
}

function fakeInst() {
  const inst = new MaiPush()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')
  return { inst, replies }
}

test('未设置的群：猜歌关、推送关（白名单默认，偏离源的黑名单）', async () => {
  await database.load()
  assert.deepEqual(database.getGroup(99999), { guess: false, aliasPush: false })
})

test('push on|off：只改本群，回执用源文案', async () => {
  await database.load()
  const { inst, replies } = fakeInst()
  const e = { msg: '#mai push on', isGroup: true, group_id: 111, isMaster: false }

  assert.equal(await inst.pushGroup(e), true)
  assert.equal(database.getGroup(111).aliasPush, true)
  assert.equal(database.getGroup(222).aliasPush, false, '不应波及其它群')
  assert.equal(replies.at(-1), '群别名推送功能已开启')

  await inst.pushGroup({ ...e, msg: '#mai push off' })
  assert.equal(database.getGroup(111).aliasPush, false)
  assert.equal(replies.at(-1), '群别名推送功能已关闭')
})

test('push on|off：私聊无群可开关 → 明确引导而非静默成功', async () => {
  await database.load()
  const { inst, replies } = fakeInst()
  await inst.pushGroup({ msg: '#mai push on', isGroup: false, isMaster: false })
  assert.match(replies.at(-1), /请在群聊中使用/)
})

test('push global on|off：一次给全部群置位', async () => {
  await database.load()
  const { inst, replies } = fakeInst()
  const original = globalThis.Bot
  globalThis.Bot = makeBot({
    uins: [1000, 2000],
    adapterBots: {
      1000: { getGroupList: async () => [11, 12] },
      2000: { getGroupList: async () => [12, 13] },
    },
  })
  try {
    await inst.pushGlobal({ msg: '#mai push global on', isMaster: true })
    for (const gid of [11, 12, 13]) {
      assert.equal(database.getGroup(gid).aliasPush, true, `群 ${gid} 应已开启`)
    }
    assert.match(replies.at(-1), /^已全局开启maimai别名推送/, '回执保留源文案')
    assert.match(replies.at(-1), /3 个群/, '多账号应取并集（11/12/13 去重后 3 个）')

    await inst.pushGlobal({ msg: '#mai push global off', isMaster: true })
    for (const gid of [11, 12, 13]) {
      assert.equal(database.getGroup(gid).aliasPush, false, `群 ${gid} 应已关闭`)
    }
    assert.match(replies.at(-1), /^已全局关闭maimai别名推送/)
  } finally {
    globalThis.Bot = original
  }
})

test('push global：取不到群列表时必须明确回执，不得静默成功', async () => {
  await database.load()
  const { inst, replies } = fakeInst()
  const original = globalThis.Bot
  globalThis.Bot = makeBot({ uins: [] })
  try {
    await inst.pushGlobal({ msg: '#mai push global on', isMaster: true })
    assert.match(replies.at(-1), /未能取到任何群列表/, '管理员以为已全局开启而实际零置位是最难排查的状态')
    assert.match(replies.at(-1), /#mai push on/, '应给出可执行的替代方案')
  } finally {
    globalThis.Bot = original
  }
})

test('getAllGroups：适配器实取优先于宿主缓存', async () => {
  const bot = makeBot({
    uins: [1000],
    adapterBots: { 1000: { getGroupList: async () => [1, 2] } },
    caches: { 1000: [9] },
  })
  assert.deepEqual(await getAllGroups(bot), [1, 2], '有实取就不该读可能不全的缓存')
})

test('getAllGroups：适配器未实现 getGroupList 时退回缓存', async () => {
  const bot = makeBot({ uins: [1000], adapterBots: { 1000: {} }, caches: { 1000: [7, 8] } })
  assert.deepEqual((await getAllGroups(bot)).sort(), [7, 8])
})

test('getAllGroups：单账号实取失败不影响其余，并退回该账号缓存', async () => {
  const bot = makeBot({
    uins: [1000, 2000],
    adapterBots: {
      1000: { getGroupList: async () => { throw new Error('适配器炸了') } },
      2000: { getGroupList: async () => [21] },
    },
    caches: { 1000: [19] },
  })
  assert.deepEqual((await getAllGroups(bot)).sort(), [19, 21])
})

test('getAllGroups：无账号或结构异常时返回空数组（不抛）', async () => {
  assert.deepEqual(await getAllGroups(makeBot({})), [])
  assert.deepEqual(await getAllGroups(undefined), [])
  assert.deepEqual(await getAllGroups({ uin: [1] }), [], '缺 bots/Bot[uin] 时应安全返回空')
})
