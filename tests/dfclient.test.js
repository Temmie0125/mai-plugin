/**
 * 水鱼客户端端点单测（P2b；源 efa55a9 后重写）
 *
 * 手法：打桩 globalThis.fetch，直接断言**真实发出的请求**（URL / method / body）。
 * 源 efa55a9（v3.1.5）后成绩查询只剩 OAuth GET /player/records 一条通道：
 * 旧 /dev/*、/query/plate 已随开发者 token 废弃，这里守的是——
 * ① 一切成绩查询都打到 /player/records 且带 Bearer；② 筛选条件走 query string，
 * 数组按 httpx 语义展开成重复键；③ undefined 的筛选项不上送。
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

let DivingFishAPI = null
let getPlayerResult = null
let database = null

/** 打桩 fetch：记录调用，按 url 路由返回 `{status, body}` */
function stubFetch(route) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const body = init.body ? (init.body instanceof URLSearchParams ? init.body.toString() : init.body) : null
    calls.push({ url: u, method: init.method, body, headers: init.headers || {} })
    const r = route(u, init) ?? {}
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      url: u,                       // 真实 fetch 的 Response 带 url；_handleError 靠它区分 403 来源
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    }
  }
  return calls
}

const findCall = (calls, frag) => calls.find(c => c.url.includes(frag))

test('准备：动态载入被测模块（logger 打桩须先于 service 顶层求值）', async () => {
  ({ DivingFishAPI } = await import('../lib/client/divingfish.js'))
  ;({ getPlayerResult } = await import('../lib/handler.js'))
  database = await import('../lib/database.js')
  database.setDataRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-dfclient-')))
  assert.ok(DivingFishAPI && getPlayerResult)
})

// =====================================================================
// queryUserRecords（源 efa55a9 后的唯一成绩端点，OAuth-only）
// =====================================================================

test('queryUserRecords：GET /player/records，无筛选时不带 query string', async () => {
  const calls = stubFetch((u) => u.includes('/oauth/token')
    ? { body: { access_token: 'TK2', expires_in: 300 } }
    : { body: { records: [{ song_id: 9 }] } })

  const api = new DivingFishAPI(114516)
  const out = await api.queryUserRecords()

  const call = findCall(calls, '/player/records')
  assert.ok(call, '应打到 /player/records')
  assert.equal(call.method, 'GET')
  assert.equal(call.body, null)
  assert.doesNotMatch(call.url, /\?/, '无筛选不得携带查询串')
  assert.equal(call.headers.Authorization, 'Bearer TK2')
  assert.deepEqual(out, [{ song_id: 9 }])
})

test('queryUserRecords：筛选条件走 query string，数组展开为重复键，undefined 不上送', async () => {
  const calls = stubFetch((u) => u.includes('/oauth/token')
    ? { body: { access_token: 'TK3', expires_in: 300 } }
    : { body: { records: [{ song_id: 7 }, { song_id: 8 }] } })

  const api = new DivingFishAPI(114521)
  const out = await api.queryUserRecords({ song_id: 371, level: '13+', fc: ['ap', 'app'], version: ['彩'] })

  const call = findCall(calls, '/player/records')
  assert.ok(call, '应打到 /player/records')
  assert.match(call.url, /[?&]song_id=371/)
  assert.match(call.url, /[?&]level=13%2B/, 'URLSearchParams 会把 + 编码为 %2B')
  assert.match(call.url, /[?&]fc=ap&fc=app/, '数组按 httpx 语义展开成重复键（非逗号拼接）')
  assert.match(call.url, /[?&]version=%E5%BD%A9/)
  assert.doesNotMatch(call.url, /(ds|fs|plate|level_index)=/, '未给的筛选项不得上送')
  assert.equal(call.headers.Authorization, 'Bearer TK3')
  assert.deepEqual(out, [{ song_id: 7 }, { song_id: 8 }])
})

test('queryUserRecords：records 缺失时回退空数组', async () => {
  stubFetch((u) => u.includes('/oauth/token')
    ? { body: { access_token: 'TK4', expires_in: 300 } }
    : { body: {} })
  const api = new DivingFishAPI(114522)
  assert.deepEqual(await api.queryUserRecords({ song_id: 1 }), [])
})

// =====================================================================
// getPlayerResult
// =====================================================================

test('getPlayerResult：openid 无 QQ → 直接给水鱼引导，不发请求', async () => {
  const calls = stubFetch(() => ({ body: {} }))
  const hint = await getPlayerResult({ key: 'openid-abc', qqid: null, service: 'df' })
  assert.ok(hint?.dfHint, '应返回 DF_QQ_HINT 引导对象')
  assert.equal(calls.length, 0, '不得发起任何网络请求')
})

test('getPlayerResult：落雪 → GET /scores，映射为 PlayedResult[]', async () => {
  const calls = stubFetch(() => ({
    body: {
      code: 0,
      data: [{
        id: 1451, song_name: 'テスト', level: '13', level_index: 3,
        type: 'dx', achievements: 100.5, dx_score: 2000, dx_rating: 300, fc: 'ap', fs: 'fsd', rate: 'sss',
      }],
    },
  }))
  const out = await getPlayerResult({ key: 'k', qqid: 114517, service: 'lxns', accessToken: 'AT', refreshToken: 'RT' })

  const call = findCall(calls, '/scores')
  assert.ok(call, '应打到落雪 /scores')
  assert.equal(call.headers.Authorization, 'Bearer AT')
  assert.equal(out.length, 1)
  // 新 API 文档：「标准/DX 曲目 ID 一致，不存在大于 10000 的曲目 ID」
  // ⇒ DX 的 id 是 <10000，须 +10000 还原成仓内的 DX song_id
  assert.equal(out[0].song_id, 1451 + 10000, 'DX 谱 song_id 应 +10000 还原')
  assert.equal(out[0].rating, 300)
})

test('lxnsFormatResult：已带 10000 偏移的 id 不再二次偏移（旧快照/旧缓存的兼容）', async () => {
  const { lxnsFormatResult } = await import('../lib/merge/playResult.js')
  assert.equal(lxnsFormatResult({ id: 1451, type: 'dx', achievements: 100 }).song_id, 11451)
  assert.equal(lxnsFormatResult({ id: 11451, type: 'dx', achievements: 100 }).song_id, 11451,
    '已是 10001+ 的 id 视为已还原，保持原值')
  assert.equal(lxnsFormatResult({ id: 1451, type: 'standard', achievements: 100 }).song_id, 1451,
    '标准谱不加偏移')
})

// =====================================================================
// 403 分源：公开查询 vs 代用户端点（真机反馈：绑定好好的却被报「尚未授权」）
// =====================================================================

test('403 映射：公开查询 vs OAuth 代查端点（真机反馈：绑定好好的却被报「尚未授权」）', async () => {
  const { DivingFishUserDisabledQueryError, DivingFishNotAuthorizedError } =
    await import('../lib/client/errors.js')

  // ① b50 走公开端点（不带凭据），用户没开「允许他人查询」→ 403
  stubFetch(() => ({ status: 403, body: { message: 'user not allow to query' } }))
  const api = new DivingFishAPI(114518)
  await assert.rejects(() => api.queryUserB50(), DivingFishUserDisabledQueryError,
    '公开端点 403 应说「该用户禁止了其他人获取数据」，而不是冤枉绑定')

  // ② /player/records 源 efa55a9 后必然携带 Bearer，403 即授权问题（判据是端点而非 oauth 配置）
  stubFetch(u => (u.includes('/oauth/token')
    ? { body: { access_token: 'TK', expires_in: 300 } }
    : { status: 403, body: { message: 'forbidden' } }))
  await assert.rejects(() => new DivingFishAPI(114519).queryUserRecords(), DivingFishNotAuthorizedError)

  // ③ 公开端点 403 仍是「用户禁止他人查询」，与源一致
  stubFetch(() => ({ status: 403, body: {} }))
  await assert.rejects(() => new DivingFishAPI(null, 'someone').queryUserB50(), DivingFishUserDisabledQueryError)
})
