/**
 * @代查目标解析回归 —— 单测（lib/user.js getUserAndAuth）
 *
 * 背景（2026-10-08 官方QQBot 真机）：`@bot #mai b50` 被误判为「代查 bot 自己」——
 * 旧实现直接重扫 `e.message` 原始数组捡 at 段，而宿主 loader（lib/plugins/loader.js
 * dealEvent）对 at 段是「qq == self_id → 只置 e.atBot、不置 e.at」。官方群 bot 只收
 * @ 消息（适配器还会给每条群消息补一个 at-bot 段），at-bot 的 qq 是纯数字 self_id，
 * 于是每次 @ 调用都被当成 @代查 bot → 水鱼查不到该 QQ → 全量群（只能 @ 调用）整个
 * 查询被闭环堵死。修复后取宿主 `e.at`（已排除 bot 自身）。
 *
 * 本文件锁定（e 的形态按宿主 loader 处理后的结果构造，e.message 保留原始 at 段
 * 以证明插件**不再**扫它）：
 *   ① @bot 调用（官方/OneBot）→ 目标是调用者本人，绝不取 bot；
 *   ② @他人代查（OneBot）→ 取被 @ 的 QQ；
 *   ③ 官方环境 at-他人（self_id:openid 形态）与 at-all → 非纯数字，回退本人；
 *   ④ allowAt=false → 一律本人。
 *
 * 全部离线：DB 落临时目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const database = await import('../lib/database.js')
const { getUserAndAuth } = await import('../lib/user.js')

const SELF_ID = '3889698912'      // bot 的 self_id（官方 QQBot 按 QQ 形态注册）
const INVOKER = '114514'          // 调用者 QQ
const OTHER = '123456'            // 被 @ 代查的 QQ

function tmpDb() {
  database.setDataRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-at-')))
  return database.load()
}

/** 宿主 loader（dealEvent）对 at 段的产出：at-self → e.atBot；否则 e.at（多个以最后为准） */
function loaderProcessed({ ats, selfId = SELF_ID }) {
  const e = {
    user_id: INVOKER,
    message: [],
    reply: async () => {},
  }
  for (const qq of ats) {
    e.message.push({ type: 'at', qq })
    // eslint-disable-next-line eqeqeq
    if (String(qq) == selfId) e.atBot = true
    else e.at = qq
  }
  e.message.push({ type: 'text', text: '#mai b50' })
  return e
}

test('@bot 调用（官方QQBot 群消息：适配器补 at-bot 段）→ 目标是调用者本人', async () => {
  await tmpDb()
  // 官方环境原始消息：[at(self_id), text]；e.at 应为 undefined（loader 已滤掉 at-bot）
  const e = loaderProcessed({ ats: [SELF_ID] })
  const got = await getUserAndAuth(e, { autoCreate: true })
  assert.ok(got)
  assert.equal(got.targetQq, INVOKER, '不得把 bot 的 QQ 当代查目标')
  assert.equal(got.user.key, INVOKER)
})

test('@bot 调用（OneBot：qq 为数字）同样取调用者本人', async () => {
  await tmpDb()
  const e = loaderProcessed({ ats: [SELF_ID] })
  const got = await getUserAndAuth(e)
  assert.equal(got.targetQq, INVOKER)
})

test('@他人代查（OneBot）→ 取被 @ 的 QQ；@bot + @他人 亦然', async () => {
  await tmpDb()
  const only = await getUserAndAuth(loaderProcessed({ ats: [OTHER] }))
  assert.equal(only.targetQq, OTHER)

  const both = await getUserAndAuth(loaderProcessed({ ats: [SELF_ID, OTHER] }))
  assert.equal(both.targetQq, OTHER, 'at-bot 被滤掉后，e.at 是被 @ 的用户')
})

test('官方环境 at-他人（self_id:openid 形态，非纯数字）→ 回退本人', async () => {
  await tmpDb()
  const e = loaderProcessed({ ats: [`${SELF_ID}:ABCDEF1234567890`] })
  const got = await getUserAndAuth(e)
  assert.equal(got.targetQq, INVOKER, 'openid 形态不能作水鱼代查键')
})

test('at-all（e.at="all"）→ 回退本人', async () => {
  await tmpDb()
  const e = loaderProcessed({ ats: ['all'] })
  const got = await getUserAndAuth(e)
  assert.equal(got.targetQq, INVOKER)
})

test('allowAt=false → 即使有 e.at 也用本人（bind qq 等场景语义不变）', async () => {
  await tmpDb()
  const e = loaderProcessed({ ats: [OTHER] })
  const got = await getUserAndAuth(e, { allowAt: false })
  assert.equal(got.targetQq, INVOKER)
})
