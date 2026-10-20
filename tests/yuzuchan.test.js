/**
 * 柚子客户端写接口单测（P3c，设计 §7.1/§7.2）+ 反查链短超时行为
 *
 * 手法同 `tests/dfclient.test.js`：打桩 `globalThis.fetch`，断言**真实发出的请求**
 * （URL / method / body），以及 `accept_message` 的 4xx 吞与不吞。
 * 超时测试用显式小 timeout（如 50ms）驱动真实 AbortController，不等 5s 默认值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const { YuzuChaNAPI, yuzuBaseUrl, ALIAS_QUERY_TIMEOUT } = await import('../lib/client/yuzuchan.js')
const { RequestError } = await import('../lib/client/errors.js')

const realFetch = globalThis.fetch
let calls = []

/** 打桩 fetch：记录调用，按 url 路由返回 `{status, body}` */
function stubFetch(route = () => ({})) {
  calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body })
    const r = route(String(url), init) ?? {}
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    }
  }
}
const jsonOf = call => (call.body ? JSON.parse(call.body) : null)

test('yuzuBaseUrl：域名随 aliasProxy 切换（moe 默认）', () => {
  assert.equal(yuzuBaseUrl(), 'https://www.yuzuchan.moe/api/v2')
})

test('postAlias：POST /apply，body 键名照搬源且 song_id 保持字符串', async () => {
  stubFetch(() => ({ body: { message: '申请成功' } }))
  try {
    const res = await new YuzuChaNAPI().postAlias('277', '脑天', 114514, 111)
    assert.deepEqual(res, { message: '申请成功' })

    assert.equal(calls.length, 1)
    const [c] = calls
    assert.match(c.url, /^https:\/\/www\.yuzuchan\.moe\/api\/v2\/aliases\/maimaidx\/apply$/)
    assert.equal(c.method, 'POST')
    const body = jsonOf(c)
    assert.deepEqual(Object.keys(body).sort(), ['apply_alias', 'apply_uid', 'group_id', 'song_id', 'ws_uuid'])
    assert.equal(body.song_id, '277', '源侧就是字符串，端口不转数字')
    assert.equal(body.apply_alias, '脑天')
    assert.equal(body.apply_uid, 114514)
    assert.equal(body.group_id, 111)
    assert.match(body.ws_uuid, /^[0-9a-f-]{36}$/i, 'ws_uuid 是进程级会话标识')
  } finally { globalThis.fetch = realFetch }
})

test('postAlias：ws_uuid 是进程级常量（同一进程内多次请求相同）', async () => {
  stubFetch(() => ({ body: { message: 'ok' } }))
  try {
    const api = new YuzuChaNAPI()
    await api.postAlias('1', 'a', 1, 1)
    await api.postAlias('2', 'b', 2, 2)
    assert.equal(jsonOf(calls[0]).ws_uuid, jsonOf(calls[1]).ws_uuid)
  } finally { globalThis.fetch = realFetch }
})

test('postAgreeUser：POST /votes，body 为 {tag, agree_user}；tag 不再二次加工', async () => {
  stubFetch(() => ({ body: { message: '投票成功' } }))
  try {
    await new YuzuChaNAPI().postAgreeUser('ABC', 114514)
    const [c] = calls
    assert.match(c.url, /\/aliases\/maimaidx\/votes$/)
    assert.equal(c.method, 'POST')
    assert.deepEqual(jsonOf(c), { tag: 'ABC', agree_user: 114514 })
  } finally { globalThis.fetch = realFetch }
})

test('getStatus：GET /votes?status=ongoing', async () => {
  stubFetch(() => ({ body: [{ song_id: 8, tag: 'T1', apply_alias: 'x', votes: 3, agree_votes: 1 }] }))
  try {
    const list = await new YuzuChaNAPI().getStatus()
    assert.equal(list.length, 1)
    const [c] = calls
    assert.match(c.url, /\/aliases\/maimaidx\/votes\?status=ongoing$/)
    assert.equal(c.method, 'GET')
    assert.equal(c.body, undefined, 'GET 不应带 body')
  } finally { globalThis.fetch = realFetch }
})

test('getAliasesBySongId：GET /aliases?song_id=N', async () => {
  stubFetch(() => ({ body: { song_id: 8, alias: ['真爱'] } }))
  try {
    const alias = await new YuzuChaNAPI().getAliasesBySongId(8)
    assert.deepEqual(alias, { song_id: 8, alias: ['真爱'] })
    assert.match(calls[0].url, /\/aliases\/maimaidx\/aliases\?song_id=8$/)
  } finally { globalThis.fetch = realFetch }
})

test('accept_message：申请/投票/按ID查 吞 4xx 并回原始 body；getStatus 不吞', async () => {
  stubFetch(() => ({ status: 400, body: { message: '该别名已存在' } }))
  try {
    const api = new YuzuChaNAPI()
    assert.deepEqual(await api.postAlias('1', 'a', 1, 1), { message: '该别名已存在' })
    assert.deepEqual(await api.postAgreeUser('T', 1), { message: '该别名已存在' })
    assert.deepEqual(await api.getAliasesBySongId(1), { message: '该别名已存在' })
    // 源 get_status 未传 accept_message ⇒ 4xx 直接抛
    await assert.rejects(() => api.getStatus(), RequestError)
  } finally { globalThis.fetch = realFetch }
})

test('getSongs：反查链短超时默认 5s（ALIAS_QUERY_TIMEOUT）', () => {
  assert.equal(ALIAS_QUERY_TIMEOUT, 5000)
})

test('getSongs：连接挂起时按显式 timeout 掐断成 TimeoutError，且超时不重试', async () => {
  // fetch 永不 resolve，只能靠 AbortController 到点掐断（真实超时路径）
  calls = []
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    calls.push({ url: String(url), method: init.method })
    init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
  })
  try {
    await assert.rejects(
      () => new YuzuChaNAPI().getSongs('叶山', { timeout: 50 }),
      err => err.name === 'TimeoutError',
    )
    assert.equal(calls.length, 1, '慢服务器上重试只会翻倍等待，超时后不得重试')
  } finally { globalThis.fetch = realFetch }
})

test('getSongs：响应头已到但 body 挂起，同样受 timeout 约束', async () => {
  calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url) })
    return { status: 200, ok: true, json: () => new Promise(() => {}), text: () => new Promise(() => {}) }
  }
  try {
    await assert.rejects(
      () => new YuzuChaNAPI().getSongs('叶山', { timeout: 50 }),
      err => err.name === 'TimeoutError',
    )
  } finally { globalThis.fetch = realFetch }
})

test('getSongs：正常响应不受影响；GET 网络错误仍保留重试 ×1 语义', async () => {
  calls = []
  let n = 0
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url) })
    if (n++ === 0) throw new Error('ECONNRESET') // 首次网络失败 → 退避后重试
    return { status: 200, ok: true, json: async () => ({ data: [] }), text: async () => '{"data":[]}' }
  }
  try {
    assert.deepEqual(await new YuzuChaNAPI().getSongs('叶山'), { data: [] })
    assert.equal(calls.length, 2, '非超时的 GET 网络错误照旧重试一次')
  } finally { globalThis.fetch = realFetch }
})
