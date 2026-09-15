/**
 * 落雪好友码绑定与「免 OAuth」路由 —— 单测
 *
 * 背景（2026-09-15 真机）：`#mai ap50` 在落雪侧报 404（「未找到落雪查分器相关资源」）。
 * 该接口按 friend_code 取数、且要求账号开启落雪「隐私设置」三项权限；原来插件里
 * 好友码只有 OAuth 绑定顺手存过、没有任何地方用它，也没有「只绑好友码」的入口。
 *
 * 本文件锁定：
 *   ① 路由：无 OAuth 但有好友码时，player / best50 / ap50 / songBests 走开发者接口；
 *   ② 边界：全量成绩（allBest）开发者接口给不了（SimpleScore 无达成率）⇒ 明确报错引导授权；
 *   ③ 绑定：`#mai bind fc [好友码]` 的格式校验、按 QQ 解析、落库与**自动切源**；
 *   ④ requireAuth 认好友码为有效凭据（不再一刀切拦人）。
 *
 * 全部离线：`ApiClient.prototype._fetch` 换成记录 URL 的假服务端；DB 落临时目录。
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

const { ApiClient } = await import('../lib/client/http.js')
const { LxnsAPI } = await import('../lib/client/lxns.js')
const { LXNSAuthRequiredError } = await import('../lib/client/errors.js')
const { errorMessage } = await import('../lib/handlerError.js')
const database = await import('../lib/database.js')
const { bindFriendCode, isFriendCodeText, BIND_FC_NO_QQ } = await import('../lib/handler.js')
const { getUserAndAuth } = await import('../lib/user.js')

/** 假服务端：记录每个请求，按 URL 给响应 */
function stubServer(handler) {
  const urls = []
  const original = ApiClient.prototype._fetch
  ApiClient.prototype._fetch = async function (method, endpoint, kwargs = {}) {
    let url = this.baseUrl + endpoint
    if (kwargs.params) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(kwargs.params)) qs.append(k, String(v))
      url += '?' + qs.toString()
    }
    urls.push({ method, url, auth: (this.headers || {}).Authorization })
    const body = handler(url)
    return { status: 200, url, text: async () => JSON.stringify({ code: 0, data: body }) }
  }
  return { urls, restore: () => { ApiClient.prototype._fetch = original } }
}

function tmpDb() {
  database.setDataRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fc-')))
  return database.load()
}

const FC = 477875223083305   // 仅用于断言的**假**好友码

// ---------------------------------------------------------------- 路由

test('无 OAuth + 有好友码：四条查询都走开发者接口（URL 断言）', async () => {
  const server = stubServer(url => {
    if (url.includes('/bests/ap')) return { standard_total: 0, dx_total: 0, standard: [], dx: [] }
    if (url.includes('/bests')) return { standard_total: 0, dx_total: 0, standard: [], dx: [] }
    return { name: 'テスト', rating: 15000, friend_code: FC }
  })
  try {
    const api = new LxnsAPI('k', null, { friendCode: FC })
    assert.equal(api.hasOauth, false)
    assert.equal((await api.player()).friend_code, FC)
    await api.best50()
    await api.ap50()
    await api.songBests(799, 'dx')
    const hit = server.urls.map(u => u.url.replace('https://maimai.lxns.net/api/v0/maimai', ''))
    assert.deepEqual(hit, [
      `/player/${FC}`,
      `/player/${FC}/bests`,
      `/player/${FC}/bests/ap`,
      `/player/${FC}/bests?song_id=799&song_type=dx`,
    ])
    // 单曲是 /bests + query（不是单数 /best），且四个请求都带开发者 token 头
    assert.ok(!hit.some(u => u.endsWith('/best')), '单曲不要走 /best')
    assert.ok(server.urls.every(u => typeof u.auth === 'string'), '开发者请求需带 Authorization 头')
  } finally {
    server.restore()
  }
})

test('有 OAuth：仍走 OAuth 路由（不因新增好友码而改道）', async () => {
  const server = stubServer(() => ({ name: 'テスト', rating: 15000, friend_code: FC, standard: [], dx: [], standard_total: 0, dx_total: 0 }))
  try {
    const api = new LxnsAPI('k', { access_token: 'AT', refresh_token: 'RT' }, { friendCode: FC })
    assert.equal(api.hasOauth, true)
    await api.player()
    await api.best50()
    await api.songBests(799, 'dx')
    for (const u of server.urls) {
      assert.match(u.url, /\/api\/v0\/user\/maimai\/player/, `OAuth 路由：${u.url}`)
      assert.equal(u.auth, 'Bearer AT')
    }
  } finally {
    server.restore()
  }
})

test('全量成绩：无 OAuth 时明确报「需授权」，不做假数据；有 OAuth 时走 /scores', async () => {
  const server = stubServer(() => [])
  try {
    const onlyFc = new LxnsAPI('k', null, { friendCode: FC })
    await assert.rejects(() => onlyFc.allBest(), (e) => e instanceof LXNSAuthRequiredError)
    assert.equal(server.urls.length, 0, '不该发出任何请求（开发者接口没有全量成绩）')
    // 文案要指路（用户看到的必须是可操作的一句话）
    assert.match(errorMessage(new LXNSAuthRequiredError()), /bind lxns/)

    const withOauth = new LxnsAPI('k', { access_token: 'AT', refresh_token: 'RT' }, { friendCode: FC })
    await withOauth.allBest()
    assert.match(server.urls.at(-1).url, /\/api\/v0\/user\/maimai\/player\/scores$/)
  } finally {
    server.restore()
  }
})

test('两者都无：抛 LXNSTokenError（上层会引导 bind）', async () => {
  const api = new LxnsAPI('k', null)
  await assert.rejects(() => api.player(), /LXNSTokenError/)
  await assert.rejects(() => api.allBest(), /LXNSAuthRequiredError/)
})

// ---------------------------------------------------------------- 绑定

test('好友码格式：≥12 位纯数字才算（与 QQ 号区分开）', () => {
  assert.equal(isFriendCodeText(String(FC)), true)
  assert.equal(isFriendCodeText('123456789012'), true)
  assert.equal(isFriendCodeText('114514'), false, 'QQ 号长度不够')
  assert.equal(isFriendCodeText('abc123456789012'), false)
  assert.equal(isFriendCodeText(''), false)
})

test('bindFriendCode：手动绑定 → 落库 + 自动切到落雪 + 文案含前置条件', async () => {
  await tmpDb()
  const user = { key: '114514', qqid: 114514, service: 'df' }
  const msg = await bindFriendCode(user, String(FC))
  assert.match(msg, new RegExp(String(FC)))
  assert.match(msg, /数据源已切到落雪/)
  assert.match(msg, /允许读取玩家信息/, '必须提示落雪三项隐私设置')

  const row = database.getUser('114514')
  assert.equal(row.friendCode, Number(FC))
  assert.equal(row.service, 'lxns')
})

test('bindFriendCode：格式不对 → 只回提示，不落库、不改源', async () => {
  await tmpDb()
  database.updateUser('114514', { service: 'df', theme: 'prism_plus' })
  const msg = await bindFriendCode({ key: '114514', qqid: 114514, service: 'df' }, '114514')
  assert.match(msg, /好友码格式不正确/)
  const row = database.getUser('114514')
  assert.equal(row.friendCode, undefined, '非法输入不得落库')
  assert.equal(row.service, 'df', '不得改数据源')
})

test('bindFriendCode：不带参数 → 按 QQ 调 /player/qq/{qq} 解析并落库', async () => {
  await tmpDb()
  const server = stubServer(url => {
    assert.match(url, /\/player\/qq\/114514$/)
    return { name: 'テスト', rating: 15000, friend_code: FC }
  })
  try {
    const user = { key: '114514', qqid: 114514, service: 'df' }
    const msg = await bindFriendCode(user, null)
    assert.match(msg, /按 QQ 解析/)
    assert.equal(database.getUser('114514').friendCode, Number(FC))
    assert.equal(database.getUser('114514').service, 'lxns')
  } finally {
    server.restore()
  }
})

test('bindFriendCode：解析不到好友码 / 无 QQ 可读 → 各自的引导', async () => {
  await tmpDb()
  const server = stubServer(() => ({ name: 'テスト', rating: 15000 }))   // 无 friend_code
  try {
    const msg = await bindFriendCode({ key: '114514', qqid: 114514, service: 'df' }, null)
    assert.match(msg, /未能从落雪解析到你的好友码/)
    assert.equal(database.getUser('114514')?.friendCode, undefined)

    // openid 环境（无数字 QQ）：提示先 bind qq 或手输
    const noQq = await bindFriendCode({ key: 'openid-abc', service: 'df' }, null)
    assert.equal(noQq, BIND_FC_NO_QQ())
    assert.equal(server.urls.length, 1, '无 QQ 时不该发请求')
  } finally {
    server.restore()
  }
})

// ---------------------------------------------------------------- requireAuth

test('requireAuth：只绑了好友码的落雪用户不再被拦（改由 allBest 精确提示）', async () => {
  await tmpDb()
  database.updateUser('114514', { service: 'lxns', friendCode: Number(FC) })

  const replies = []
  const e = { user_id: '114514', reply: async m => { replies.push(String(m)) } }
  const got = await getUserAndAuth(e, { requireAuth: true })
  assert.ok(got, '有好友码应视为已授权')
  assert.equal(got.user.friendCode, Number(FC))
  assert.deepEqual(replies, [], '不该回「未授权」引导')

  // 三者皆无 → 仍要拦
  database.updateUser('999', { service: 'lxns' })
  replies.length = 0
  const denied = await getUserAndAuth({ user_id: '999', reply: async m => { replies.push(String(m)) } }, { requireAuth: true })
  assert.equal(denied, null)
  assert.match(replies[0], /bind lxns/)
})
