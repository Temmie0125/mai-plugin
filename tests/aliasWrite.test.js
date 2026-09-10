/**
 * 别名写路径单测（P3c，设计 §7）
 *
 * 手法：`lib/service.js:setDataRoot` 注入临时目录后走真实落盘（**绝不碰真机 data/**），
 * 断言写入语义、离线重建与规则顺序消歧。
 */
import { test, beforeEach, after } from 'node:test'
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

const service = await import('../lib/service.js')
const database = await import('../lib/database.js')
const { AliasList } = await import('../lib/merge/aliasList.js')
const { mergeAliasData } = await import('../lib/merge/merge.js')
const { MaiAlias, resolveAliasTargets } = await import('../apps/song.js')
const { sortVotes } = await import('../lib/handler.js')
const { voteListView } = await import('../lib/render/views.js')

/**
 * 打桩 fetch：`addLocal`/`applyAlias` 会做「服务器是否已有此别名」的前置校验（真联网）。
 * 不打桩的话每条用例要等网络超时（实测 16s+），且结果随网络环境漂移。
 * 默认返回空对象 ⇒ `Array.isArray(body.alias)` 为假 ⇒ 跳过前置校验，正是我们要测的路径。
 */
const realFetch = globalThis.fetch
let fetchCalls = []
function stubFetch(route = () => ({})) {
  fetchCalls = []
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: init.method, body: init.body })
    const r = route(String(url), init) ?? {}
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    }
  }
}

const YUZU = [{ song_id: 8, name: 'True Love Song', is_votable: true, alias: ['真爱', 'TLS'] }]
const SONGS = [
  { song_id: 8, song_name: 'True Love Song' },
  { song_id: 11451, song_name: '茄子' },
]

let root
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-alias-'))
  service.setDataRoot(root)
  // ⚠️ 两个模块各有独立的 dataRoot，**必须都注入**：
  //    service  → 别名文件 / 曲库缓存
  //    database → 用户表（`voteAlias`/`applyAlias` 走 getUserAndAuth + autoCreate，
  //               漏注入会以测试 user_id 往真机 data/user.json 里建行——已踩过一次）
  database.setDataRoot(root)
  fs.mkdirSync(path.join(root, 'music'), { recursive: true })
  fs.writeFileSync(path.join(root, 'music', 'music_alias.json'), JSON.stringify(YUZU))
  // 内存态：曲库 + 别名（等价于 load 完成后的样子）
  service.mai.totalList = {
    root: SONGS,
    byId: id => SONGS.find(s => s.song_id === id) ?? null,
    byName: name => SONGS.find(s => s.song_name === name) ?? null,
    filter: () => [],
  }
  service.mai.totalAliasList = AliasList.fromJSON(
    YUZU.map(a => ({ song_id: a.song_id, song_name: a.name, alias: [...a.alias] })),
  )
})

after(() => {
  service.setDataRoot(path.resolve('data'))
  database.setDataRoot(path.resolve('data'))
})

test('护栏：两个 dataRoot 都已指向临时目录（防真机数据被测试写入）', () => {
  // 这条是给上面那条教训兜底的：若日后有人删掉任一行注入，这里立刻红
  assert.ok(root.includes('mai-alias-'), '临时目录应就位')
  assert.ok(fs.existsSync(path.join(root, 'music', 'music_alias.json')), 'service 侧已注入')
  database.updateUser('999999', { service: 'df' })
  assert.ok(fs.existsSync(path.join(root, 'user.json')), 'database 侧已注入（用户表写在临时目录）')
  assert.ok(!fs.existsSync(path.resolve('data', 'user.json.999check')), '真机 data/ 不应有痕迹')
})

const localFile = () => path.join(root, 'alias', 'local_music_alias.json')
const readLocal = () => JSON.parse(fs.readFileSync(localFile(), 'utf8'))

function fakeInst() {
  const inst = new MaiAlias()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')
  return { inst, replies }
}
const mkE = msg => ({ msg, message: [], user_id: 114514, isGroup: true, group_id: 111, isMaster: false, reply: async () => {} })

test('updateLocalAlias：小写存储、去重、同时改内存、落盘', () => {
  assert.equal(service.updateLocalAlias(8, 'TLS_TEST'), true)
  assert.equal(service.updateLocalAlias(8, 'tls_test'), true, '重复（大小写不同）不应报错')

  // 内存：原柚子别名保留原大小写，本地别名小写；且只有一条
  assert.deepEqual(service.mai.totalAliasList.byId(8)[0].alias, ['真爱', 'TLS', 'tls_test'])
  assert.deepEqual(readLocal(), { 8: ['tls_test'] }, '落盘键为 songId 字符串、值为小写数组')
})

test('updateLocalAlias：目标曲在别名库中无行时新建一行（song_name 取自曲库）', () => {
  assert.equal(service.updateLocalAlias(11451, '茄子别名'), true)
  const row = service.mai.totalAliasList.byId(11451)[0]
  assert.equal(row.song_name, '茄子')
  assert.deepEqual(row.alias, ['茄子别名'])
  assert.deepEqual(readLocal(), { 11451: ['茄子别名'] })
})

test('rebuildAliasFromCache：产出与直接调 mergeAliasData 逐字段一致', () => {
  service.updateLocalAlias(8, 'TLS_TEST')
  assert.equal(service.rebuildAliasFromCache(), true)

  const written = JSON.parse(fs.readFileSync(path.join(root, 'music', 'merge_music_alias.json'), 'utf8'))
  const expect = mergeAliasData({ yuzuAliases: YUZU, lxnsAliases: null, localAliasData: readLocal() })
  assert.deepEqual(written, expect.root, '重建结果必须与合并函数同口径')
  assert.deepEqual(service.mai.totalAliasList.root, expect.root, '内存态也应同步刷新')
  assert.ok(written.find(r => r.song_id === 8).alias.includes('tls_test'), '本地别名应已生效')
})

test('rebuildAliasFromCache：缓存缺失时返回 false（交调用方联网兜底）', () => {
  fs.rmSync(path.join(root, 'music', 'music_alias.json'))
  assert.equal(service.rebuildAliasFromCache(), false)
})

test('规则顺序：动作词五条必须声明在通配查询之前（靠顺序消歧，勿调换）', () => {
  const fncs = new MaiAlias().rule.map(r => r.fnc)
  assert.deepEqual(fncs, ['syncAlias', 'addLocal', 'applyAlias', 'voteAlias', 'listVotes', 'queryAlias'])
  // 宿主按 rule 数组顺序首中先服务（lib/plugins/loader.js 的 for...of i.plugin.rule），
  // 故「首个命中」必须落在动作词上，而不是通配查询
  const rules = new MaiAlias().rule.map(r => ({ fnc: r.fnc, reg: new RegExp(r.reg) }))
  const firstHit = msg => rules.find(r => r.reg.test(msg))?.fnc
  assert.equal(firstHit('#mai alias sync'), 'syncAlias')
  assert.equal(firstHit('#mai alias local 8 真爱'), 'addLocal')
  assert.equal(firstHit('#mai alias apply 8 脑天'), 'applyAlias')
  assert.equal(firstHit('#mai alias vote ABC'), 'voteAlias')
  assert.equal(firstHit('#mai alias votes'), 'listVotes')
  assert.equal(firstHit('#mai 当前投票'), 'listVotes')
  // 不带动作词的一律落到查询
  assert.equal(firstHit('#mai alias 悲怆'), 'queryAlias')
  assert.equal(firstHit('#mai alias 8'), 'queryAlias')
  assert.equal(firstHit('#mai alias votesx'), 'queryAlias', '动作词的近形应落回查询而非误判')
})

test('alias sync 仅主人可用，回执用源文案', async () => {
  const { inst, replies } = fakeInst()
  const orig = service.mai.getMusicAlias
  service.mai.getMusicAlias = async () => { throw new Error('柚子挂了') }
  try {
    await inst.syncAlias(mkE('#mai alias sync'))
    assert.equal(replies.at(-1), '手动更新别名库失败')
    service.mai.getMusicAlias = async () => {}
    await inst.syncAlias(mkE('#mai alias sync'))
    assert.equal(replies.at(-1), '手动更新别名库成功')
  } finally {
    service.mai.getMusicAlias = orig
  }
})

test('addLocal：校验顺序与文案逐字（源 mai_alias.py:51-81）', async () => {
  // 曲 8 在「服务器」上已有别名（含一个大写项，用于验证大小写不敏感比较）
  stubFetch(url => (url.includes('song_id=8')
    ? { body: { song_id: 8, name: 'True Love Song', is_votable: true, alias: ['真爱', 'TLS'] } }
    : {}))
  try {
    const { inst, replies } = fakeInst()
    const run = async msg => { replies.length = 0; await inst.addLocal(mkE(msg)); return replies.at(-1) }

    // 直接调处理器（绕过规则层），故「无参」也由处理器自身的 `len != 2` 守卫兜住
    assert.equal(await run('#mai alias local 8'), '参数错误', '只有一个参数')
    assert.equal(await run('#mai 本地别名 8 甲 乙'), '参数错误', '三个参数（源 len != 2 同样拒绝）')
    assert.equal(await run('#mai alias local abc 别名'), '请输入正确的ID')
    assert.equal(await run('#mai alias local 99999 别名'), '未找到ID「99999」的曲目')

    const ok = await run('#mai alias local 11451 新别名')
    assert.equal(ok, '已成功为ID「11451」添加别名「新别名」到本地别名库')
    assert.deepEqual(readLocal(), { 11451: ['新别名'] }, '成功后应落盘')
    assert.ok(fetchCalls.some(c => c.url.includes('song_id=11451')), '应做过「服务器是否已有」的前置校验')

    assert.equal(await run('#mai alias local 11451 新别名'), '本地别名库已存在该别名', '重复添加应被拒')
    assert.equal(await run('#mai alias local 8 TLS'), '该曲目的别名「TLS」已存在别名服务器')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('addLocal：服务器不可达时跳过前置校验，仍能加本地别名（比源宽容）', async () => {
  stubFetch(() => { throw new Error('网络不通') })
  try {
    const { inst, replies } = fakeInst()
    await inst.addLocal(mkE('#mai alias local 11451 离线别名'))
    assert.equal(replies.at(-1), '已成功为ID「11451」添加别名「离线别名」到本地别名库')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------------------------------------------------------------
// 投票列表：`#N` 编号口径（图上的编号必须与投票时解析出的 tag 一一对应）
// ---------------------------------------------------------------------

/** 夹具取自真实返回（注意有 tag 自带前导「- 」，这正是要编号的原因） */
const RAW_VOTES = [
  { tag: 'J0LA1', song_id: 399, apply_alias: '没毛', agree_votes: 0, votes: 5, name: '' },
  { tag: '6NQ2D', song_id: 375, apply_alias: 'osa', agree_votes: 0, votes: 5, name: '' },
  { tag: '- XFDM4', song_id: 11872, apply_alias: '无言', agree_votes: 0, votes: 5, name: '' },
  { tag: '2Y150', song_id: 389, apply_alias: '服老二', agree_votes: 0, votes: 5, name: '' },
  { tag: '- J1W42', song_id: 203, apply_alias: '帮帮我', agree_votes: 0, votes: 5, name: '' },
]

test('sortVotes：确定性排序，与入参顺序无关（编号口径的唯一来源）', () => {
  const a = sortVotes(RAW_VOTES).map(v => v.tag)
  const b = sortVotes([...RAW_VOTES].reverse()).map(v => v.tag)
  assert.deepEqual(a, b, '倒序输入应得到同一编号顺序')
  assert.deepEqual(a, ['- J1W42', '6NQ2D', '2Y150', 'J0LA1', '- XFDM4'], '按 song_id 升序：203/375/389/399/11872')
})

test('voteListView：图上编号 = startIndex + 位次（跨页连续）', () => {
  const sorted = sortVotes(RAW_VOTES)
  const p1 = voteListView({ votes: sorted.slice(0, 3), page: 1, totalPage: 2, botName: 'T', startIndex: 0 })
  assert.deepEqual(p1.texts.filter(t => /^#\d+$/.test(t.text)).map(t => t.text), ['#1', '#2', '#3'])
  const p2 = voteListView({ votes: sorted.slice(3), page: 2, totalPage: 2, botName: 'T', startIndex: 3 })
  assert.deepEqual(p2.texts.filter(t => /^#\d+$/.test(t.text)).map(t => t.text), ['#4', '#5'])
})

test('voteListView：编号与 tag 同排展示（用户按 #N 投票时能对上）', () => {
  const sorted = sortVotes(RAW_VOTES)
  const view = voteListView({ votes: sorted.slice(0, 2), page: 1, totalPage: 1, botName: 'T', startIndex: 0 })
  const num1 = view.texts.find(t => t.text === '#1')
  const tag1 = view.texts.find(t => t.text === '- J1W42')
  assert.ok(num1 && tag1, '编号与首个 tag 都应在图上')
  assert.equal(num1.y, tag1.y, '编号与 tag 必须同一行')
  assert.ok(tag1.x > num1.x, 'tag 紧随编号之后')
})

test('voteAlias：#N 按同一排序口径换回真实 tag 再投票', async () => {
  stubFetch(url => (url.includes('/votes') ? { body: RAW_VOTES } : {}))
  try {
    const { inst, replies } = fakeInst()
    // 只关心「发出的 tag 是否正确」，请求体即证据
    await inst.voteAlias(mkE('#mai alias vote #3'))
    const posted = fetchCalls.find(c => c.method === 'POST')
    assert.ok(posted, '应发出投票 POST')
    assert.equal(JSON.parse(posted.body).tag, '2Y150', '#3 应对应排序后的第 3 条')
    assert.equal(JSON.parse(posted.body).agree_user, 114514)
    assert.equal(replies.length, 1, '投票结果按服务端回执原样转发')
  } finally { globalThis.fetch = realFetch }
})

test('voteAlias：#N 越界时给明确引导，不发请求', async () => {
  stubFetch(() => ({ body: RAW_VOTES }))
  try {
    const { inst, replies } = fakeInst()
    await inst.voteAlias(mkE('#mai vote #99'))
    assert.match(replies.at(-1), /没有编号 99 的投票/)
    assert.match(replies.at(-1), /#mai alias votes/, '应引导去看带编号的列表')
    assert.equal(fetchCalls.filter(c => c.method === 'POST').length, 0, '越界不应发出投票请求')
  } finally { globalThis.fetch = realFetch }
})

test('voteAlias：直接给 tag 时原样 toUpperCase 发出（含自带前导「- 」的 tag）', async () => {
  stubFetch(() => ({ body: { message: 'ok' } }))
  try {
    const { inst } = fakeInst()
    await inst.voteAlias(mkE('#mai vote - xfdm4'))
    assert.equal(JSON.parse(fetchCalls.find(c => c.method === 'POST').body).tag, '- XFDM4')
    assert.equal(fetchCalls.filter(c => c.method === 'GET').length, 0, '直接给 tag 无需先查列表')
  } finally { globalThis.fetch = realFetch }
})

test('addLocal：本地别名加完即生效（不必等联网更新）', () => {
  // 源此处只改内存，要等下次「更新别名库」才落进合并库 —— 端口用缓存重建消除了这段延迟
  service.updateLocalAlias(11451, '茄子别名')
  assert.equal(service.rebuildAliasFromCache(), true)
  assert.ok(resolveAliasTargets('茄子别名').some(s => s.song_id === 11451), '新别名应立刻可被查到')
})
