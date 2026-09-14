/**
 * 落雪令牌刷新的一次性语义 vs 单次命令内多实例 —— 回归测试
 *
 * 病灶（真机复现）：`getToken(user)` 原先读的是**命令开始时的 user 快照**
 * （getUserAndAuth 返回的 `{...row, key}` 副本）。而 401 触发的刷新会把新令牌写回
 * user.json（database.updateUser），快照**不会**跟着变。落雪的 refresh_token 是
 * **单次使用、刷新即轮换**的（lib/database.js 文件头：「401 刷新轮换后的新
 * refresh_token…服务端已轮换 → 旧值失效」）。
 *
 * 于是同一次命令里若先后构造**两个** LxnsAPI 实例：
 *   实例A 请求 → 401 → 用快照的 refresh_token 刷新 ✓（落盘）
 *   实例B 仍用**快照里已失效的 access_token** → 401
 *        → 再用**已被轮换掉的 refresh_token** 刷新 → 失败
 *        → _onUnauthorized 静默 return false（无重试）→ _handleError(401)
 *        → LXNSOAuthError「落雪查分器授权错误，请重试，依旧错误请重新绑定授权。」
 *
 * 症状「首次失败、重试就好」的成因：A 的刷新已落盘、凭据已变新，后续命令重新取快照
 * 即拿到新值 → 不再 401。错误文案里的「请重试」总是灵验，把根因盖住了。
 * 而「update 没问题」只是因为拟合b50 已经替它刷新过凭据。
 *
 * 受害命令 = 单次调用里构造 ≥2 个 LxnsAPI 实例的三条：
 *   拟合b50（getPlayerHeader + getPlayerResultCached）
 *   rise / update（getBest50WithCache + getPlayerResultCached）
 * 其余命令单实例，该实例刷新后会自我更新 headers，故不发作。
 *
 * 全部离线：_fetch 被替换成模拟落雪语义的假服务端，不触网。
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
const database = await import('../lib/database.js')
const scoreCache = await import('../lib/scoreCache.js')
const { getFitBest50, getBest50WithCache, getPlayerResultCached } = await import('../lib/handler.js')

const KEY = '114514'

/** 模拟落雪语义的假服务端：access 失效即 401；refresh_token **单次使用、刷新即轮换** */
function fakeLxnsServer({ before = null } = {}) {
  const st = { access: 'ACCESS_1', refresh: 'REFRESH_1', gen: 1, usedRefresh: new Set(), calls: [] }
  const resp = (status, body) => ({ status, text: async () => JSON.stringify(body) })

  const original = ApiClient.prototype._fetch
  ApiClient.prototype._fetch = async function (method, endpoint, kwargs = {}) {
    const url = this.baseUrl + endpoint
    const auth = { ...(this.headers || {}), ...(kwargs.headers || {}) }.Authorization
    const body = kwargs.json

    if (body?.grant_type === 'refresh_token') {
      st.calls.push({ url, kind: 'refresh', sent: body.refresh_token })
      if (st.usedRefresh.has(body.refresh_token) || body.refresh_token !== st.refresh) {
        before?.()                                       // 拒绝前的窄竞态窗口
        return resp(401, { message: 'invalid_grant' })   // 已轮换 = 永久失效
      }
      st.usedRefresh.add(body.refresh_token)
      st.gen += 1
      st.access = `ACCESS_${st.gen}`
      st.refresh = `REFRESH_${st.gen}`
      return resp(200, {
        access_token: st.access, refresh_token: st.refresh, token_type: 'Bearer',
      })
    }

    st.calls.push({ url, kind: 'api', sent: auth })
    if (auth !== `Bearer ${st.access}`) return resp(401, { message: 'unauthorized' })

    if (url.endsWith('/player/scores')) return resp(200, { code: 0, data: [] })
    if (url.endsWith('/bests')) {
      return resp(200, { code: 0, data: { standard_total: 0, dx_total: 0, standard: [], dx: [] } })
    }
    return resp(200, {
      code: 0, data: { name: 'テスト', rating: 15000, friend_code: 123456789, trophy: null },
    })
  }

  return {
    st,
    refreshCount: () => st.calls.filter(c => c.kind === 'refresh').length,
    apiSends: () => st.calls.filter(c => c.kind === 'api').map(c => c.sent),
    restore() { ApiClient.prototype._fetch = original },
  }
}

/** 建库并写入**已失效**的凭据；返回命令开始时的用户快照（与 getUserAndAuth 同形） */
async function freshUser() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-lxnstoken-'))
  database.setDataRoot(tmp)
  scoreCache.setDataRoot(tmp)          // records 无缓存 → 不回退，确保走到真实拉取
  await database.load()
  database.updateUser(KEY, {
    service: 'lxns', accessToken: 'STALE_TOKEN', refreshToken: 'REFRESH_1',
  })
  return { ...database.getUser(KEY), key: KEY }
}

test('拟合b50：access 失效时首次查询应正常返回，而非报授权错误', async () => {
  const srv = fakeLxnsServer()
  try {
    const user = await freshUser()
    const data = await getFitBest50(user)
    assert.equal(data.empty, true, '应正常走到「无可拟合成绩」分支（空曲库）')

    // 关键：整条命令只刷新一次 —— 第二个实例必须用上刷新后的新凭据
    assert.equal(srv.refreshCount(), 1, '整条命令只应发生一次刷新')
    assert.deepEqual(srv.apiSends(), [
      'Bearer STALE_TOKEN',   // 实例A：player() 撞上失效 access
      'Bearer ACCESS_2',      //        刷新后重试成功
      'Bearer ACCESS_2',      // 实例B：allBest() 直接用刷新后的凭据，不再撞 401
    ], '调用序列不应出现「重复的陈旧凭据」')
  } finally {
    srv.restore()
  }
})

test('拟合b50：刷新结果落盘，后续命令无需再次刷新', async () => {
  const srv = fakeLxnsServer()
  try {
    const first = await freshUser()
    await getFitBest50(first)
    const afterFirst = srv.refreshCount()

    const second = { ...database.getUser(KEY), key: KEY }   // 下一条命令重新取快照
    await getFitBest50(second)
    assert.equal(srv.refreshCount(), afterFirst, '凭据已新鲜，第二次不应再刷新')
    assert.equal(database.getUser(KEY).accessToken, 'ACCESS_2')
  } finally {
    srv.restore()
  }
})

test('补强·并发：两实例都已持有旧凭据时，第二个实例应改用库内新凭据恢复', async () => {
  const srv = fakeLxnsServer()
  try {
    await freshUser()
    // 两个实例在**任何刷新发生之前**构造 —— 等价于两条命令并发（各自读到同一份旧快照）
    const a = new LxnsAPI(KEY, { access_token: 'STALE_TOKEN', refresh_token: 'REFRESH_1' })
    const b = new LxnsAPI(KEY, { access_token: 'STALE_TOKEN', refresh_token: 'REFRESH_1' })

    await a.player()                       // 401 → 刷新 ✓ → 重试成功
    const allBest = await b.allBest()      // 401 → 刷新失败（已轮换）→ 应兜底取库内新凭据
    assert.deepEqual(allBest, [])

    assert.equal(srv.refreshCount(), 1, '只应发生一次刷新（第二个实例不该再消耗一次轮换）')
  } finally {
    srv.restore()
  }
})

test('同形态的既有命令（rise / update）同样不再失败', async () => {
  const srv = fakeLxnsServer()
  try {
    const user = await freshUser()
    await getBest50WithCache(user)          // 实例A：player + best50
    const records = await getPlayerResultCached(user)   // 实例B：allBest
    assert.deepEqual(records, [])
    assert.equal(srv.refreshCount(), 1, '两条命令形态合计只刷新一次')
  } finally {
    srv.restore()
  }
})

test('补强·窄竞态：刷新被拒的瞬间别处刚好落盘，也应靠库内新凭据恢复', async () => {
  let fired = false
  const srv = fakeLxnsServer({
    // 模拟「另一个实例已经消费掉 refresh_token、正要把新凭据写库」的那个瞬间：
    // 我们的 ① 检查（刷新前）读到的还是旧值，刷新被拒后才看得到新值。
    before: () => {
      if (fired) return
      fired = true
      srv.st.gen += 1
      srv.st.access = `ACCESS_${srv.st.gen}`
      srv.st.refresh = `REFRESH_${srv.st.gen}`
      database.updateUser(KEY, { accessToken: srv.st.access, refreshToken: srv.st.refresh })
    },
  })
  try {
    const user = await freshUser()
    srv.st.usedRefresh.add('REFRESH_1')   // 库内仍是 STALE/REFRESH_1，但该 refresh_token 已被别处消费
    assert.equal(database.getUser(KEY).accessToken, 'STALE_TOKEN', '① 检查时库内尚未更新')

    const data = await getFitBest50(user)
    assert.equal(data.empty, true, '应靠刷新失败后的兜底恢复，而非报授权错误')
    assert.equal(database.getUser(KEY).accessToken, 'ACCESS_2')
  } finally {
    srv.restore()
  }
})

test('真·凭据失效（refresh_token 也不可用）仍应抛授权错误，不得静默吞掉', async () => {
  const srv = fakeLxnsServer()
  try {
    const user = await freshUser()
    srv.st.refresh = 'ROTATED_ELSEWHERE'    // 库里的 refresh_token 已彻底失效
    await assert.rejects(() => getFitBest50(user), /LXNSOAuthError|授权/,
      '无法恢复时必须照常抛错，让用户重新绑定')
  } finally {
    srv.restore()
  }
})
