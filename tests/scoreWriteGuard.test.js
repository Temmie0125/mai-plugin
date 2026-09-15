/**
 * D17 不变量：b50 缓存的**唯一写入口**与变体护栏（设计《拟合b50实现设计.md》§5.2 / §9）
 *
 * 守的是什么：后续要在 b50 原语上做 FC50 / FC+50 / FDX50 / 随心配b50 等
 * **带限定条件的变体**。这些变体经 lxnsToBest50 转换后与真实 B50 形状完全一致、
 * totals 亦各自自洽，一旦写进缓存，事后**无法从内容分辨**——AP50 已经踩过一次，
 * 且是静默的。
 *
 * ⚠️ 本文件报错时**先修架构，再改测试**。
 *
 * 全部离线：client 方法经 prototype 打桩，不触网；缓存写进临时目录，不碰真机 data/。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const { DivingFishAPI } = await import('../lib/client/divingfish.js')
const { LxnsAPI } = await import('../lib/client/lxns.js')
const scoreCache = await import('../lib/scoreCache.js')
const {
  getBest50, getBest50WithCache, getPlayerResultCached,
} = await import('../lib/handler.js')

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ------------------------------------------------- 源码级断言用的公共工具

/** lib/ 与 apps/ 下的全部 .js（含子目录，如 lib/render） */
function walkJsFiles() {
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) files.push(p)
    }
  }
  walk(path.join(PLUGIN_ROOT, 'lib'))
  walk(path.join(PLUGIN_ROOT, 'apps'))
  return files
}

/** 命中的**非注释**行（去掉注释行，避免命中文档里写的示例） */
function callSites(src, re) {
  return src.split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => {
      const t = line.trimStart()
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false
      return re.test(line)
    })
}

const relOf = file => path.relative(PLUGIN_ROOT, file).replace(/\\/g, '/')

// ---------------------------------------------------------------- fixtures

/** df 侧最小 userinfo（/query/player 形态） */
const DF_USERINFO = {
  nickname: 'テスト',
  rating: 15000,
  additional_rating: 0,
  plate: null,
  charts: {
    sd: [{ song_id: 1, title: 'S1', level: '13', level_index: 3, type: 'SD', ds: 13, ra: 300, achievements: 100.5, fc: '', fs: '', rate: 'sssp', dxScore: 1000 }],
    dx: [{ song_id: 10001, title: 'S2', level: '13', level_index: 3, type: 'DX', ds: 13, ra: 310, achievements: 100.6, fc: '', fs: '', rate: 'sssp', dxScore: 900 }],
  },
}

/** df 侧最小全量成绩（/dev/player/records 形态，键名与 verlist 不同） */
const DF_RECORDS = [
  { id: 1, title: 'S1', level: '13', level_index: 3, type: 'SD', ds: 13, ra: 300, achievements: 100.5, fc: '', fs: '', rate: 'sssp', dxScore: 1000 },
  { id: 2, title: 'S3', level: '13', level_index: 3, type: 'SD', ds: 13, ra: 290, achievements: 99.5, fc: '', fs: '', rate: 'sss', dxScore: 800 },
]

/** 落雪侧最小 best50 / ap50 响应（两端点同形态——正是 B2 事故的成因） */
const LXNS_BESTS = { standard_total: 100, dx_total: 50, standard: [], dx: [] }
const LXNS_PLAYER = { name: 'テスト', rating: 15000, friend_code: 123456789 }
/** 落雪侧最小全量成绩（allBest 形态；type 为 standard|dx，song_id 由 type 还原） */
const LXNS_ALLBEST = [
  { id: 1, type: 'standard', song_name: 'S1', level: '13', level_index: 3, achievements: 100.5, fc: '', fs: '', dx_score: 1000 },
  { id: 2, type: 'dx', song_name: 'S2', level: '13', level_index: 3, achievements: 99.5, fc: '', fs: '', dx_score: 900 },
]

const dfUser = () => ({ key: '114514', qqid: 114514, service: 'df' })
const lxnsUser = () => ({ key: '114514', qqid: 114514, service: 'lxns', accessToken: 'tok' })

/** 打桩：替换 client 方法，返回计数器 + restore */
function stubClients() {
  const original = {
    dfB50: DivingFishAPI.prototype.queryUserB50,
    dfRecords: DivingFishAPI.prototype.queryUserRecords,
    dfPlate: DivingFishAPI.prototype.queryUserPlate,
    lxPlayer: LxnsAPI.prototype.player,
    lxBests: LxnsAPI.prototype.best50,
    lxAp: LxnsAPI.prototype.ap50,
    lxAllBest: LxnsAPI.prototype.allBest,
  }
  const calls = { dfB50: 0, dfRecords: 0, dfPlate: 0, player: 0, best50: 0, ap50: 0, allBest: 0 }

  DivingFishAPI.prototype.queryUserB50 = async function () { calls.dfB50++; return DF_USERINFO }
  DivingFishAPI.prototype.queryUserRecords = async function () { calls.dfRecords++; return DF_RECORDS }
  DivingFishAPI.prototype.queryUserPlate = async function () { calls.dfPlate++; return [] }
  LxnsAPI.prototype.player = async function () { calls.player++; return LXNS_PLAYER }
  LxnsAPI.prototype.best50 = async function () { calls.best50++; return LXNS_BESTS }
  LxnsAPI.prototype.ap50 = async function () { calls.ap50++; return LXNS_BESTS }
  LxnsAPI.prototype.allBest = async function () { calls.allBest++; return LXNS_ALLBEST }

  return {
    calls,
    restore() {
      DivingFishAPI.prototype.queryUserB50 = original.dfB50
      DivingFishAPI.prototype.queryUserRecords = original.dfRecords
      DivingFishAPI.prototype.queryUserPlate = original.dfPlate
      LxnsAPI.prototype.player = original.lxPlayer
      LxnsAPI.prototype.best50 = original.lxBests
      LxnsAPI.prototype.ap50 = original.lxAp
      LxnsAPI.prototype.allBest = original.lxAllBest
    },
  }
}

/** 当前注入的缓存根目录（每个用例重新 mkdtemp） */
let currentRoot = ''

function tmpRoot() {
  currentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-writeguard-'))
  scoreCache.setDataRoot(currentRoot)
  return currentRoot
}

const cachePathOf = (kind, user) =>
  path.join(currentRoot, kind, `${scoreCache.cacheFileName(user.key)}.json`)

const b50Files = () => {
  const dir = path.join(currentRoot, 'b50')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

// ---------------------------------------------------------------- 护栏（b50）

test('护栏①：getBest50 原语带任何选项都不写缓存', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    // 三条**变体流**：username 显式用户名 / allPerfect 的 AP50 / 未来变体的假想选项
    const byName = await getBest50(dfUser(), { username: 'someone' })
    assert.ok(Array.isArray(byName) && byName[1].sd.length, 'username 流应正常返回数据')
    const byAp = await getBest50(lxnsUser(), { allPerfect: true })
    assert.ok(Array.isArray(byAp), 'allPerfect 流应正常返回数据')
    const byFuture = await getBest50(dfUser(), { pool: 'fc50' })
    assert.ok(Array.isArray(byFuture), '假想的未来变体选项应正常返回数据')

    assert.deepEqual(b50Files(), [], '任何变体流都不得产生 b50 缓存文件')
  } finally {
    stub.restore()
  }
})

test('护栏②：getBest50WithCache 是唯一写点，且写的就是本次真实 B50', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    const user = dfUser()
    const result = await getBest50WithCache(user)
    assert.ok(Array.isArray(result))

    assert.equal(b50Files().length, 1, '真实 B50 应恰好写 1 个文件')

    const cache = scoreCache.readB50(user.key)
    assert.equal(cache.service, 'df')
    assert.equal(cache.date, scoreCache.localToday())
    // 缓存内容必须与本次拉取结果逐字段一致 —— 写入口不具备产出「别的东西」的能力
    assert.deepEqual(cache.best50, result[1])
    assert.deepEqual(cache.player, result[0])
    assert.equal(cache.best50.sd_total, 300, 'sd_total 取自 ra 之和')
    assert.equal(cache.best50.dx_total, 310)
  } finally {
    stub.restore()
  }
})

test('护栏③：写入口不接受任何选项（.length 绊线）', () => {
  // 绊线而非铁闸：若有人给写入口加**无默认值**的 options 形参（想支持变体），
  // 这里会失败；加带默认值的形参会绕过 —— 真正的护栏是「原语零副作用 +
  // 写入口无法表达变体」这一结构，以及下面的源码级断言。
  assert.equal(getBest50WithCache.length, 1, '写入口只应接受 user 一个形参')
})

test('护栏④（源码级）：writeB50 的调用点全仓唯一，且在 handler', () => {
  const writeHits = []
  const withCacheHits = []
  for (const f of walkJsFiles()) {
    const src = fs.readFileSync(f, 'utf8')
    const rel = relOf(f)
    // scoreCache.js 自身是定义处（export function writeB50），不算调用点
    if (rel !== 'lib/scoreCache.js') {
      for (const h of callSites(src, /\.writeB50\s*\(/)) writeHits.push(`${rel}:${h.no}`)
    }
    for (const h of callSites(src, /getBest50WithCache\s*\(/)) {
      if (/function\s+getBest50WithCache/.test(h.line)) continue   // 定义行
      withCacheHits.push(`${rel}:${h.no}`)
    }
  }

  assert.equal(writeHits.length, 1,
    `writeB50 调用点必须全仓唯一，实际 ${writeHits.length} 处：${JSON.stringify(writeHits)}`
    + '。变体（FC50/随心配b50…）只能读缓存，禁止写盘。')
  assert.ok(writeHits[0].startsWith('lib/handler.js:'),
    `唯一写点应在 lib/handler.js，实际：${writeHits[0]}`)

  // 调用点白名单：新增第 6 个调用方时必须回来复核它是不是「真实 B50」，
  // 因此这条**故意**是计数断言 —— 它失败即为提醒，不是回归。
  assert.equal(withCacheHits.length, 5,
    `写入口调用点应为 5 处（drawBest50 / updatePlayerCache / getMaiWhat / drawRiseScoreList / getB50ForCalc），`
    + `实际 ${withCacheHits.length} 处：${JSON.stringify(withCacheHits)}。`
    + '新增调用方前请确认它拉取的是无任何限定条件的真实 B50。')
})

test('护栏⑤（源码级）：随心配变体三件套与命令层不出现任何写盘调用', () => {
  // 变体（含水鱼 AP50、理论/新歌/旧版本列表）**只读** records 缓存，且不经 b50 写入口。
  // 这条把《b50扩展实现设计.md》§9 的承诺锁进测试：将来给变体「顺手写个缓存」会立刻失败。
  const targets = [
    'lib/variantSpec.js', 'lib/variantB50.js', 'lib/b50Core.js', 'apps/score.js',
  ]
  const forbidden = [
    [/\.writeB50\s*\(/, 'scoreCache.writeB50'],
    [/\.writeRecords\s*\(/, 'scoreCache.writeRecords'],
    [/getBest50WithCache\s*\(/, 'getBest50WithCache（b50 唯一写入口）'],
  ]
  const hits = []
  for (const rel of targets) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8')
    for (const h of callSites(src, /./)) {           // 逐行（callSites 已滤掉注释）
      for (const [re, name] of forbidden) {
        if (re.test(h.line)) hits.push(`${rel}:${h.no} 出现 ${name}`)
      }
    }
  }
  assert.deepEqual(hits, [],
    `变体路径禁止任何写盘调用，实际命中：${JSON.stringify(hits, null, 2)}`)
})

test('消费方切换锁（源码级）：records 消费方一律走 cached，原语只剩 cached 内部一处', () => {
  const plain = []
  const cached = []
  for (const f of walkJsFiles()) {
    const src = fs.readFileSync(f, 'utf8')
    const rel = relOf(f)
    // ⚠️ `getPlayerResultCached(` 不含子串 `getPlayerResult(`，故精确串匹配即可区分
    for (const h of callSites(src, /getPlayerResult\s*\(/)) {
      if (h.line.includes('getPlayerResultCached(')) continue
      if (/function\s+getPlayerResult\s*\(/.test(h.line)) continue     // 定义行
      plain.push(`${rel}:${h.no}`)
    }
    for (const h of callSites(src, /getPlayerResultCached\s*\(/)) {
      if (/function\s+getPlayerResultCached/.test(h.line)) continue    // 定义行
      cached.push(`${rel}:${h.no}`)
    }
  }

  // 消费方切换（设计 §5.5）的回退护栏：谁把某个表族改回实时直拉，这里立刻失败
  assert.deepEqual(plain, [`lib/handler.js:${plain[0]?.split(':')[1]}`],
    `getPlayerResult 原语应只剩 getPlayerResultCached 内部一处调用，实际：${JSON.stringify(plain)}`
    + '。表族消费方一律走 getPlayerResultCached（每日本地缓存），勿改回实时直拉。')

  // 计数式绊线：新增 records 消费方时回来确认它是否也该走缓存
  // 12 处 = §5.5 的 6 个表族消费方 + getFitBest50 + updatePlayerCache
  //       + 随心配家族 3 个（drawVariantBest50 / drawSong50 / drawFilteredScoreList）
  //       + getAp50（水鱼 AP50 与「落雪接口失败回退」**共用**这一条本地管线，故只此一处）
  //       见《b50扩展实现设计.md》§6/§9——全部是只读消费方，无一写盘
  assert.equal(cached.length, 12,
    `getPlayerResultCached 调用点应为 12 处（§5.5 的 6 个表族消费方 + getFitBest50 + updatePlayerCache`
    + ` + 随心配的 3 个 + getAp50），实际 ${cached.length} 处：${JSON.stringify(cached)}`)
})

// ---------------------------------------------------------------- AP50（接口优先 / 失败回退）

/** 打桩曲库（AP50 的本地回退要用 isnew 分池） */
async function withFakeLib(lib, fn) {
  const { mai } = await import('../lib/service.js')
  const saved = mai.totalList
  mai.totalList = lib
  try {
    return await fn()
  } finally {
    mai.totalList = saved
  }
}

const FAKE_LIB = {
  byId: id => ({
    1: { song_id: 1, isnew: false, difficulties: [] },
    10001: { song_id: 10001, isnew: true, difficulties: [] },
  })[id] ?? null,
}

test('AP50 落雪：接口正常 → source=lxns-api，且**不产生任何本地缓存**', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    const { getAp50 } = await import('../lib/handler.js')
    const data = await getAp50(lxnsUser())
    assert.equal(data.source, 'lxns-api')
    assert.equal(stub.calls.ap50, 1, '应走 /bests/ap 接口')
    assert.equal(stub.calls.allBest, 0, '接口成功时不该去拉全量')
    assert.deepEqual(fs.existsSync(path.join(currentRoot, 'b50')) ? fs.readdirSync(path.join(currentRoot, 'b50')) : [], [],
      '接口流是变体，不得写 b50 缓存（D17）')
    assert.ok(!fs.existsSync(path.join(currentRoot, 'records')), '更不该写 records 缓存')
  } finally {
    stub.restore()
  }
})

test('AP50 落雪：接口 404「score not found」= 空结果（不打回退、不告警）', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    const { getAp50, AP50_EMPTY_TEXT } = await import('../lib/handler.js')
    // 实测语义：好友码有效但没有 AP 成绩时，落雪就是回 404 + message "score not found"
    LxnsAPI.prototype.ap50 = async () => {
      throw Object.assign(new Error('LXNSNotFoundError'), {
        name: 'LXNSNotFoundError', status: 404, apiMessage: 'score not found',
      })
    }
    let allBestCalls = 0
    LxnsAPI.prototype.allBest = async () => { allBestCalls += 1; return [] }

    const data = await withFakeLib(FAKE_LIB, () => getAp50(lxnsUser()))
    assert.deepEqual(data, { empty: true }, '应直接判为空结果')
    assert.equal(allBestCalls, 0, '空结果不该再去拉全量（白跑一趟）')
    assert.match(AP50_EMPTY_TEXT, /还没有符合条件/)
  } finally {
    stub.restore()
  }
})

test('AP50 落雪：接口真失败（非「无成绩」）→ 回退本地全量计算', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    const { getAp50 } = await import('../lib/handler.js')
    // 模拟「接口真的不可用」：403 权限不足（= 账号未开启落雪隐私设置里的读取权限）
    LxnsAPI.prototype.ap50 = async () => {
      throw Object.assign(new Error('LXNSPermissionDeniedError'), {
        name: 'LXNSPermissionDeniedError',
        status: 403,
        apiMessage: 'permission denied',
        url: 'https://maimai.lxns.net/api/v0/maimai/player/0/bests/ap',
      })
    }
    // 回退数据源：本人 OAuth 全量成绩（含 AP 成绩）。
    // ⚠️ 自己计数，别用 stub.calls.allBest —— 覆盖掉桩函数后那个计数器就失效了
    let allBestCalls = 0
    LxnsAPI.prototype.allBest = async () => {
      allBestCalls += 1
      return [
        // 新 API 约定：DX 与标准同 ID（<10000），由 lxnsFormatResult 还原成仓内的 +10000
        { id: 1, type: 'standard', song_name: 'S1', level: '13', level_index: 3, achievements: 100.5, fc: 'ap', fs: '', dx_score: 1000 },
        { id: 1, type: 'dx', song_name: 'S2', level: '13', level_index: 3, achievements: 100.6, fc: 'app', fs: '', dx_score: 900 },
        { id: 2, type: 'standard', song_name: 'S3', level: '13', level_index: 3, achievements: 99.0, fc: 'fc', fs: '', dx_score: 800 },
      ]
    }

    const data = await withFakeLib(FAKE_LIB, () => getAp50(lxnsUser()))
    assert.equal(data.source, 'local', '接口失败应回退本地计算')
    assert.equal(allBestCalls, 1, '回退应拉一次全量成绩')
    // 只有 ap/app 两条入选（fc 那条被过滤），并按 isnew 分池
    assert.deepEqual(data.best50.sd.map(x => x.song_id), [1])
    assert.deepEqual(data.best50.dx.map(x => x.song_id), [10001])
    assert.deepEqual(b50Files(), [], '回退路径同样不得写 b50 缓存')
  } finally {
    stub.restore()
  }
})

test('AP50 水鱼：不走接口，直接本地全量计算', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    const { getAp50 } = await import('../lib/handler.js')
    DivingFishAPI.prototype.queryUserRecords = async () => [
      { id: 1, title: 'S1', level: '13', level_index: 3, type: 'SD', ds: 13, ra: 300, achievements: 100.5, fc: 'ap', fs: '', rate: 'sssp', dxScore: 1000 },
      { id: 2, title: 'S2', level: '13', level_index: 3, type: 'SD', ds: 13, ra: 290, achievements: 100.0, fc: 'fcp', fs: '', rate: 'sss', dxScore: 900 },
    ]
    const data = await withFakeLib(FAKE_LIB, () => getAp50(dfUser()))
    assert.equal(data.source, 'local')
    assert.equal(stub.calls.ap50, 0, '水鱼不该去请求落雪接口')
    assert.deepEqual(data.best50.sd.map(x => x.song_id), [1], '只收 ap/app')
    assert.deepEqual(b50Files(), [])
  } finally {
    stub.restore()
  }
})

// ---------------------------------------------------------------- 护栏（records）

test('records 护栏：走无 version 路径（df 轻接口永不被调用）', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    const user = dfUser()
    const records = await getPlayerResultCached(user)

    assert.equal(stub.calls.dfRecords, 1, '应走全量接口')
    assert.equal(stub.calls.dfPlate, 0, '不得走 df 轻接口（其结果是版本过滤的子集，属变体数据）')
    assert.equal(records.length, DF_RECORDS.length)

    const cache = scoreCache.readRecords(user.key)
    assert.ok(cache, '应落盘')
    assert.deepEqual(cache.records, records, '落盘内容即未过滤的全量')
    assert.ok(!fs.existsSync(`${cachePathOf('records', user)}.tmp`), '不应残留 .tmp')
  } finally {
    stub.restore()
  }
})

test('records 每日首次：当日第二次读缓存不再请求；force 强制重拉', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    const user = dfUser()

    await getPlayerResultCached(user)
    assert.equal(stub.calls.dfRecords, 1)
    await getPlayerResultCached(user)
    assert.equal(stub.calls.dfRecords, 1, '当日第二次应直接读缓存')

    await getPlayerResultCached(user, { force: true })
    assert.equal(stub.calls.dfRecords, 2, 'force 应强制重拉')
  } finally {
    stub.restore()
  }
})

test('records 换源即过期：service 戳不匹配时重拉', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    await getPlayerResultCached(dfUser())
    assert.equal(stub.calls.dfRecords, 1)

    // 模拟 #mai source 切到落雪：同一用户键、不同 service 戳
    const switched = { ...dfUser(), service: 'lxns', accessToken: 'tok' }
    const records = await getPlayerResultCached(switched)
    assert.equal(stub.calls.dfRecords, 1, '不应再打 df')
    assert.equal(stub.calls.allBest, 1, '换源后应改走落雪全量接口')
    assert.equal(records.length, LXNS_ALLBEST.length, '拿到的应是新源的数据')
    assert.equal(scoreCache.readRecords(switched.key).service, 'lxns', '戳记应更新为新源')
  } finally {
    stub.restore()
  }
})

test('D9：拉取失败回退旧缓存；force 失败则照常抛错', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    const user = dfUser()
    const fetched = await getPlayerResultCached(user)
    assert.equal(stub.calls.dfRecords, 1)

    // 把落盘日期改成「昨天」，制造「缓存过期 + 网络失败」的窗口
    const file = cachePathOf('records', user)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.date = '2000-01-01'
    fs.writeFileSync(file, JSON.stringify(raw))

    DivingFishAPI.prototype.queryUserRecords = async () => { throw new Error('ECONNRESET') }

    const fallback = await getPlayerResultCached(user)
    assert.deepEqual(fallback, fetched, '应回退旧缓存内容（D9）')
    assert.equal(stub.calls.dfRecords, 1, '回退路径不应重复请求')

    await assert.rejects(() => getPlayerResultCached(user, { force: true }),
      /ECONNRESET/, 'force 语义就是要新鲜 —— 失败必须抛错，不得回退')
  } finally {
    stub.restore()
  }
})

test('D9 无缓存可退：拉取失败直接抛错（不吞）', async () => {
  const stub = stubClients()
  try {
    tmpRoot()
    DivingFishAPI.prototype.queryUserRecords = async () => { throw new Error('ETIMEDOUT') }
    await assert.rejects(() => getPlayerResultCached(dfUser()), /ETIMEDOUT/)
  } finally {
    stub.restore()
  }
})
