import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ---- 落雪 OAuth 纯函数（lib/lxnsOauth.js）----
test('lxnsOauth：授权码三形态提取 + 拒收', async () => {
  const { extractAuthorizationCode } = await import('../lib/lxnsOauth.js')
  // 裸码 XXXX-XXXX-XXXX
  assert.equal(extractAuthorizationCode('AB12-CD34-EF56'), 'AB12-CD34-EF56')
  // 长 base64url 形态
  const long = 'a'.repeat(16) + '_-'
  assert.equal(extractAuthorizationCode(long), long)
  // 前缀与全角冒号
  assert.equal(extractAuthorizationCode('授权码：AB12-CD34-EF56'), 'AB12-CD34-EF56')
  assert.equal(extractAuthorizationCode('授权码: ab12_cdef_ABCDEFGH_ijklmnop'), 'ab12_cdef_ABCDEFGH_ijklmnop')
  // 完整回调 URL
  assert.equal(
    extractAuthorizationCode('https://example.com/cb?code=AB12-CD34-EF56&state=x'),
    'AB12-CD34-EF56',
  )
  // 拒收
  assert.equal(extractAuthorizationCode('AB12-CD34-EF5'), null)
  assert.equal(extractAuthorizationCode('授权码：not-a-code'), null)
  assert.equal(extractAuthorizationCode('随便聊聊'), null)
})

test('lxnsOauth：授权 URL 构造（query 键序与 scope）', async () => {
  const { buildAuthorizeUrl } = await import('../lib/lxnsOauth.js')
  const url = buildAuthorizeUrl('cid-123', 'https://bot.example/cb')
  const parsed = new URL(url)
  assert.equal(parsed.origin, 'https://maimai.lxns.net')
  assert.equal(parsed.pathname, '/oauth/authorize')
  assert.equal(parsed.searchParams.get('response_type'), 'code')
  assert.equal(parsed.searchParams.get('client_id'), 'cid-123')
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://bot.example/cb')
  assert.equal(parsed.searchParams.get('scope'), 'read_player read_user_profile write_player')
})

// ---- 水鱼 OAuth 纯函数（client/divingfishOauth.js）----
test('divingfishOauth：subjectRef/bindingLabel/TokenCache', async () => {
  const { subjectRef, bindingLabel, TokenCache } = await import('../lib/client/divingfishOauth.js')
  const ref = subjectRef(114514)
  assert.match(ref, /^[0-9a-f]{64}$/) // sha256 hex
  assert.equal(bindingLabel(114514), 'QQ 11**14')
  assert.equal(bindingLabel(123), 'QQ 123')

  // clock 注入口：过期判定含 30s 余量
  let now = 1000
  const cache = new TokenCache(() => now)
  cache.set('ref', { access_token: 'tok', expires_in: 100 })
  assert.equal(cache.get('ref'), 'tok')
  now = 1000 + 100 - 30 + 1 // 余量边界后
  assert.equal(cache.get('ref'), null)
})

// ---- service/theme 索引辅助（merge/models.js）----
test('models：source/theme 索引映射与帮助文本', async () => {
  const { serviceNameByIndex, serviceHelp, themeNameByIndex, themeHelp } =
    await import('../lib/merge/models.js')
  assert.equal(serviceNameByIndex('0'), 'df')
  assert.equal(serviceNameByIndex('1'), 'lxns')
  assert.equal(serviceNameByIndex('2'), null)
  assert.equal(themeNameByIndex('0'), 'prism_plus')
  assert.equal(themeNameByIndex('1'), 'circle')
  assert.equal(themeNameByIndex(''), null)
  assert.match(serviceHelp(), /「0」：Diving-Fish\n「1」：Lxns-Network/)
  assert.match(themeHelp(), /「0」：prism_plus\n「1」：circle/)
})

// ---- bind 规则与两档错误分类（apps/bind.js）----
test('bind 规则：命中/拒收样例', async () => {
  const { MaiBind, classifyBindError } = await import('../apps/bind.js')
  const { LXNSOAuthError, LXNSTooManyRequestsError } = await import('../lib/client/errors.js')
  const { ApiError } = await import('../lib/client/errors.js')
  const { UnknownError } = await import('../lib/client/errors.js')

  const inst = new MaiBind()
  const regs = inst.rule.map(r => ({ reg: new RegExp(r.reg), fnc: r.fnc }))
  const hit = msg => regs.filter(r => r.reg.test(msg)).map(r => r.fnc)
  for (const msg of [
    '#mai bind lxns', '#mai bind df', '#mai source 0', '#mai theme 1',
    '#mai lxbind', '#mai 绑定水鱼', '#mai dfbind', '#mai 数据源', '#mai 主题',
  ]) {
    assert.ok(hit(msg).length === 1, `应唯一命中：${msg}`)
  }
  for (const msg of ['#maibindlxns', '#mai bind', '#mai sourcex', 'bind lxns', '#mai song 1']) {
    assert.equal(hit(msg).length, 0, `不应命中：${msg}`)
  }
  // 两档分类：落雪 HTTP 族 → 一档；网络/未知 → 二档
  assert.match(classifyBindError(new LXNSOAuthError()), /授权码可能已使用、已过期/)
  assert.match(classifyBindError(new LXNSTooManyRequestsError()), /授权码可能已使用、已过期/)
  assert.match(classifyBindError(new ApiError('网络请求失败')), /暂时失败/)
  assert.match(classifyBindError(new UnknownError()), /暂时失败/)
  assert.match(classifyBindError(new Error('写盘失败')), /暂时失败/)
})

// ---- rank 文本纯函数（lib/handler.js）----
test('rank：列表页/名次文本锁值', async () => {
  const { rankListText, rankNameText, fmtRankTime } = await import('../lib/handler.js')
  const rows = Array.from({ length: 102 }, (_, i) => ({ username: `u${i}`, ra: 15000 - i }))
  const time = '2026-09-09 12:00:00'
  const list = rankListText({ rows, time, page: 3 })
  assert.equal(list.page, 3)
  assert.equal(list.totalPages, 3)
  assert.match(list.text, /^截止至「2026-09-09 12:00:00」，查分器已注册用户 RA 排行：/)
  assert.match(list.text, /No\.101\.「14900」 u100\nNo\.102\.「14899」 u101/)
  assert.match(list.text, /第「3 \/ 3」页，共「102」名玩家$/)
  // 页越界夹取
  assert.equal(rankListText({ rows, time, page: 99 }).page, 3)
  // 名次文本（lowercase 匹配）
  assert.equal(
    rankNameText({ rows, time, name: 'U1' }),
    '截止至「2026-09-09 12:00:00」玩家「u1」\n在查分器已注册用户 RA 排行第「2」位',
  )
  assert.match(rankNameText({ rows, time, name: 'nobody' }), /^未在查分器排行榜前「102」名中找到玩家「nobody」/)
  // 时间格式
  assert.equal(fmtRankTime(new Date(2026, 8, 9, 1, 2, 3)), '2026-09-09 01:02:03')
})

// ---- migrate-userdb 幂等（临时 sqlite fixture）----
test('migrate-userdb：导入映射 + 幂等 + 只补空字段', async () => {
  const { migrateUserDb } = await import('../scripts/migrate-userdb.mjs')
  const { DatabaseSync } = await import('node:sqlite')
  const dir = mkdtempSync(path.join(tmpdir(), 'mai-mig-'))
  const dbPath = path.join(dir, 'user.db')
  const userJsonPath = path.join(dir, 'user.json')

  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE user (qqid INTEGER PRIMARY KEY, friend_code INTEGER, access_token TEXT, refresh_token TEXT, service TEXT, theme TEXT)')
  db.prepare('INSERT INTO user VALUES (?, ?, ?, ?, ?, ?)').run(111, 555, 'ak1', 'rk1', 'LXNS', 'CIRCLE')
  db.prepare('INSERT INTO user VALUES (?, ?, ?, ?, ?, ?)').run(222, null, null, null, 'DIVINGFISH', 'PRISM_PLUS')
  db.close()

  writeFileSync(userJsonPath, JSON.stringify({
    users: { '222': { qqid: 222, service: 'lxns', theme: 'circle' } }, // 预置：字段非空应不被覆盖
  }))

  const first = migrateUserDb({ dbPath, userJsonPath })
  const second = migrateUserDb({ dbPath, userJsonPath })
  assert.equal(first.imported, 1)
  assert.equal(second.imported + second.updated, 0)

  const users = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(userJsonPath, 'utf8'))).users
  // 新导入行全字段映射
  assert.deepEqual(users['111'], {
    qqid: 111, service: 'lxns', theme: 'circle', friendCode: 555,
    accessToken: 'ak1', refreshToken: 'rk1',
  })
  // 预置行保留（只补空字段方向不被违反）
  assert.deepEqual(users['222'], { qqid: 222, service: 'lxns', theme: 'circle' })
  rmSync(dir, { recursive: true, force: true })
})
