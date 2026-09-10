/**
 * 水鱼客户端新增端点与 getPlayerResult 单测（P2b）
 *
 * 手法：打桩 globalThis.fetch，直接断言**真实发出的请求**（URL / method / body）。
 * 重点守的是移植期钉死的那条不变量：**oauth 分支必须用独立 payload，绝不能把 qq 泄漏进
 * /player/plate 或 /player/records**（源 client.py:116/135；泄漏会导致代查越权到别的账号）。
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
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    }
  }
  return calls
}

const jsonBody = (call) => (call.body ? JSON.parse(call.body) : null)
const findCall = (calls, frag) => calls.find(c => c.url.includes(frag))

test('准备：动态载入被测模块（logger 打桩须先于 service 顶层求值）', async () => {
  ({ DivingFishAPI } = await import('../lib/client/divingfish.js'))
  ;({ getPlayerResult } = await import('../lib/handler.js'))
  database = await import('../lib/database.js')
  database.setDataRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-dfclient-')))
  assert.ok(DivingFishAPI && getPlayerResult)
})

// =====================================================================
// queryUserPlate
// =====================================================================

test('queryUserPlate 非 oauth：POST /query/plate，载荷含查询载体 + version', async () => {
  const calls = stubFetch(() => ({ body: { verlist: [{ song_id: 1 }, { song_id: 2 }] } }))
  const api = new DivingFishAPI(null, 'someuser') // 传 username → oauth 关闭
  assert.equal(api.oauth, false)
  const out = await api.queryUserPlate(['maimai でらっくす PRiSM PLUS'])

  const call = findCall(calls, '/query/plate')
  assert.ok(call, '应打到 /query/plate')
  assert.equal(call.method, 'POST')
  assert.deepEqual(jsonBody(call), { username: 'someuser', version: ['maimai でらっくす PRiSM PLUS'] })
  assert.deepEqual(out, [{ song_id: 1 }, { song_id: 2 }])
})

test('queryUserPlate oauth：POST /player/plate，载荷**只有 version**（不得带 qq）', async () => {
  const calls = stubFetch((u) => u.includes('/oauth/token')
    ? { body: { access_token: 'TK', expires_in: 300 } }
    : { body: { verlist: [{ song_id: 7 }] } })

  const api = new DivingFishAPI(114515)
  api.oauth = true // 强制走 oauth 分支（不依赖本机是否配了 df 凭据）
  const out = await api.queryUserPlate(['v'])

  const call = findCall(calls, '/player/plate')
  assert.ok(call, '应打到 /player/plate')
  assert.equal(call.method, 'POST')
  assert.deepEqual(jsonBody(call), { version: ['v'] }, 'oauth 载荷必须仅含 version')
  assert.equal(jsonBody(call).qq, undefined, 'qq 不得泄漏进 oauth 端点')
  assert.equal(call.headers.Authorization, 'Bearer TK')
  assert.deepEqual(out, [{ song_id: 7 }])
})

test('queryUserPlate：verlist 缺失时回退空数组', async () => {
  stubFetch(() => ({ body: {} }))
  const api = new DivingFishAPI(null, 'u')
  assert.deepEqual(await api.queryUserPlate(['v']), [])
})

// =====================================================================
// queryUserRecords
// =====================================================================

test('queryUserRecords 非 oauth：GET /dev/player/records（载荷走 query string）', async () => {
  const calls = stubFetch(() => ({ body: { records: [{ song_id: 3 }] } }))
  const api = new DivingFishAPI(null, 'someuser')
  const out = await api.queryUserRecords()

  const call = findCall(calls, '/dev/player/records')
  assert.ok(call, '应打到 /dev/player/records')
  assert.equal(call.method, 'GET')
  assert.equal(call.body, null)
  assert.match(call.url, /[?&]username=someuser/)
  assert.doesNotMatch(call.url, /[?&]qq=/, 'username 流不应携带 qq')
  assert.deepEqual(out, [{ song_id: 3 }])
})

test('queryUserRecords oauth：GET /player/records，无 query 参数', async () => {
  const calls = stubFetch((u) => u.includes('/oauth/token')
    ? { body: { access_token: 'TK2', expires_in: 300 } }
    : { body: { records: [{ song_id: 9 }] } })

  const api = new DivingFishAPI(114516)
  api.oauth = true
  const out = await api.queryUserRecords()

  const call = findCall(calls, '/player/records')
  assert.ok(call, '应打到 /player/records')
  assert.equal(call.method, 'GET')
  assert.equal(call.body, null)
  assert.doesNotMatch(call.url, /\?/, 'oauth 端点不得携带查询串')
  assert.equal(call.headers.Authorization, 'Bearer TK2')
  assert.deepEqual(out, [{ song_id: 9 }])
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
        id: 11451, song_name: 'テスト', level: '13', level_index: 3,
        type: 'dx', achievements: 100.5, dx_score: 2000, dx_rating: 300, fc: 'ap', fs: 'fsd', rate: 'sss',
      }],
    },
  }))
  const out = await getPlayerResult({ key: 'k', qqid: 114517, service: 'lxns', accessToken: 'AT', refreshToken: 'RT' })

  const call = findCall(calls, '/scores')
  assert.ok(call, '应打到落雪 /scores')
  assert.equal(call.headers.Authorization, 'Bearer AT')
  assert.equal(out.length, 1)
  assert.equal(out[0].song_id, 11451 + 10000, 'DX 谱 song_id 应 +10000')
  assert.equal(out[0].rating, 300)
})
