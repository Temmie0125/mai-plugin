/**
 * 弗一把（fib）单测
 *
 * 纯判定（parseFibArgs / versionOrder / compare* / createFibRow / 次数表 / 冷却）直接断言；
 * 状态机（guessFib 路由与结算）用假 mai 曲库 + `setTimeScale` 加速空闲超时，
 * 群开关走 `database.setDataRoot(mkdtemp)`，绝不碰真机 data/。
 * 渲染在测试环境走 renderer 缺失的降级路径（img() 返回错误文案字符串），不真出图。
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!global.logger) {
  global.logger = new Proxy(console.log.bind(console), {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const database = await import('../lib/database.js')
const service = await import('../lib/service.js')
const { AliasList } = await import('../lib/merge/aliasList.js')
const g = await import('../lib/guess.js')
const fib = await import('../lib/fib.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 揭晓载荷的文案部分：数组取首元素（[文案, 图]），字符串原样（渲染降级 `${前缀}${错误}`） */
const payloadText = p => (Array.isArray(p) ? String(p[0]) : String(p))

const GID = 424242

/** 谱面构造器：只生成 spec 里给出的难度位次，且保留位次下标（缺席位次 = difficulties[pos] 为 undefined） */
const diffs = spec => {
  const arr = []
  for (const i of [0, 1, 2, 3, 4]) {
    if (!spec[i]) continue
    arr[i] = {
      level_index: i,
      level: spec[i].level ?? '1',
      level_value: spec[i].ds ?? 1,
      note_designer: spec[i].nd ?? '',
      notes: { total: spec[i].total ?? 100 },
    }
  }
  return arr
}

const SONGS = [
  {
    song_id: 100, song_name: 'Orange Song', artist: 'A', genre: '舞萌', bpm: 150, type: 'SD',
    version_str: 'maimai ORANGE', version_int: 14000,
    difficulties: diffs({ 3: { ds: 12.5, nd: 'Jack', total: 500, level: '12+' } }),
  },
  {
    song_id: 101, song_name: 'Orange Plus Song', artist: 'A', genre: '舞萌', bpm: 155, type: 'SD',
    version_str: 'maimai ORANGE PLUS', version_int: 15000,
    difficulties: diffs({ 3: { ds: 12.7, nd: 'Jack', total: 600, level: '13' } }),
  },
  {
    song_id: 102, song_name: 'DX Song', artist: 'B', genre: '音击&中二节奏', bpm: 200, type: 'DX',
    version_str: 'maimai でらっくす', version_int: 20106,
    difficulties: diffs({ 3: { ds: 13.6, nd: 'SAMPLE', total: 1200, level: '13+' } }),
  },
  {
    song_id: 103, song_name: 'Prism Song', artist: 'C', genre: '东方Project', bpm: 250, type: 'DX',
    version_str: 'maimai でらっくす PRiSM PLUS', version_int: 25504,
    difficulties: diffs({ 3: { ds: 14.5, nd: '配信', total: 2000, level: '14+' }, 4: { ds: 13.0, nd: '白谱师', total: 900, level: '13' } }),
  },
  {
    // 无紫谱：谜底池不该收（白谱局可猜，紫谱局对比行为「未知」）
    song_id: 104, song_name: 'No Master Song', artist: 'D', genre: '舞萌', bpm: 120, type: 'SD',
    version_str: 'maimai', version_int: 10000,
    difficulties: diffs({ 2: { ds: 11.0, nd: '某人', total: 400, level: '11' } }),
  },
  {
    // 宴谱：一律不进池
    song_id: 100001, song_name: '宴谱', artist: 'E', genre: '宴会場', bpm: 150, type: 'DX',
    version_str: 'maimai でらっくす', version_int: 21000,
    difficulties: [{ level_index: 0, level: '1', level_value: 1, note_designer: '', notes: { total: 50 } }],
  },
]

const idsOf = pool => pool.map(s => s.song_id)

let root
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fib-'))
  database.setDataRoot(root)
  service.setDataRoot(root)
  service.mai.totalList = {
    root: SONGS,
    byId: id => SONGS.find(s => s.song_id === id) ?? null,
    byName: name => SONGS.find(s => s.song_name === name) ?? null,
  }
  service.mai.totalAliasList = AliasList.fromJSON([
    { song_id: 100, song_name: 'Orange Song', alias: ['橙歌', '多曲'] },
    { song_id: 101, song_name: 'Orange Plus Song', alias: ['多曲'] },
  ])
  database.updateGroup(GID, { guess: true })
  g.clearAllGames()
  fib.setTimeScale(1)
})

after(() => {
  g.clearAllGames()
  fib.setTimeScale(1)
  database.setDataRoot(path.resolve('data'))
  service.setDataRoot(path.resolve('data'))
})

// ===== 参数解析 =====

test('parseFibArgs：颜色+定数三态', () => {
  assert.deepEqual(fib.parseFibArgs(''), { levelIndex: 3, min: null, max: null })
  assert.deepEqual(fib.parseFibArgs('红12+'), { levelIndex: 2, min: 12, max: null })
  assert.deepEqual(fib.parseFibArgs('白12.5-14'), { levelIndex: 4, min: 12.5, max: 14 })
  assert.deepEqual(fib.parseFibArgs('白 12.5 ~ 14'), { levelIndex: 4, min: 12.5, max: 14 }, '容忍空格与全角连接符')
  assert.deepEqual(fib.parseFibArgs('14-12.5'), { levelIndex: 3, min: 12.5, max: 14 }, '区间端点排序')
  assert.deepEqual(fib.parseFibArgs('13.6'), { levelIndex: 3, min: 13.6, max: null }, '小数单值 = 下限')
  assert.deepEqual(fib.parseFibArgs('12'), { levelIndex: 3, min: 12, max: null }, '整数单值 = 下限')
  assert.deepEqual(fib.parseFibArgs('紫'), { levelIndex: 3, min: null, max: null })
  assert.deepEqual(fib.parseFibArgs('绿1+'), { levelIndex: 0, min: 1, max: null })
  assert.equal(fib.parseFibArgs('abc'), null, '非法字符')
  assert.equal(fib.parseFibArgs('12-'), null, '悬空连接符')
  assert.equal(fib.parseFibArgs('红黑12'), null, '两个颜色字')
})

test('versionOrder：version_int 折算版本代（子版本归入所在代）', () => {
  assert.equal(fib.versionOrder(14000), 4, 'ORANGE')
  assert.equal(fib.versionOrder(15000), 5, 'ORANGE PLUS')
  assert.equal(fib.versionOrder(20106), 13, 'でらっくす代内追加曲归入 20000 块')
  assert.equal(fib.versionOrder(25504), 19, 'PRiSM PLUS')
  assert.equal(fib.versionOrder(9999), 0, '越界下探到首代')
  assert.equal(fib.versionOrder('x'), -1, '无法解析')
  assert.equal(fib.versionKanji(20106), '熊華')
  assert.equal(fib.versionKanji(15000), '暁')
})

test('compareVersion：相邻代判相近（ORANGE ↔ ORANGE PLUS），同代子版本算相同', () => {
  assert.deepEqual(fib.compareVersion(14000, 15000, 1), { state: 'near', arrow: 'up' })
  assert.deepEqual(fib.compareVersion(20106, 19900, 1), { state: 'near', arrow: 'down' }, 'でらっくす代 与 FiNALE 代相邻')
  assert.deepEqual(fib.compareVersion(20106, 20100, 1), { state: 'same', arrow: '' }, '同代子版本不算差异')
  assert.deepEqual(fib.compareVersion(20106, 25504, 1), { state: 'diff', arrow: 'up' })
  assert.deepEqual(fib.compareVersion(14000, 15000, 0), { state: 'diff', arrow: 'up' }, '容忍 0 时相邻代不判相近')
  assert.deepEqual(fib.compareVersion(null, 15000, 1), { state: 'unknown', arrow: '' })
})

test('compareNumber / compareText / fibCooldown', () => {
  assert.deepEqual(fib.compareNumber(12.5, 12.7, 0.5), { state: 'near', arrow: 'up' })
  assert.deepEqual(fib.compareNumber(12.5, 12.5, 0.5), { state: 'same', arrow: '' })
  assert.deepEqual(fib.compareNumber(12.5, 13.6, 0.5), { state: 'diff', arrow: 'up' })
  assert.deepEqual(fib.compareNumber(null, 13.6, 0.5), { state: 'unknown', arrow: '' })
  assert.equal(fib.compareText('Jack', 'jack ').state, 'same', '大小写与首尾空白不敏感')
  assert.equal(fib.compareText('Jack', 'SAMPLE').state, 'diff')
  assert.equal(fib.compareText('', 'SAMPLE').state, 'unknown')

  const now = 1_000_000
  assert.equal(fib.fibCooldown({ now, selfSeconds: 3, groupSeconds: 0, lastSelf: now - 1000, lastGroup: 0 }).kind, 'self')
  assert.equal(fib.fibCooldown({ now, selfSeconds: 3, groupSeconds: 0, lastSelf: now - 5000, lastGroup: 0 }).kind, '')
  const both = fib.fibCooldown({ now, selfSeconds: 5, groupSeconds: 10, lastSelf: now - 1000, lastGroup: now - 1000 })
  assert.equal(both.kind, 'group', '取剩余更长的一项')
  assert.equal(both.seconds, 9)
})

test('parseGuessNumTable / guessNumLimit', () => {
  assert.deepEqual(fib.parseGuessNumTable('8,9,10,12,14,17,20'), [8, 9, 10, 12, 14, 17, 20])
  assert.deepEqual(fib.parseGuessNumTable('6，7'), [6, 7], '全角逗号')
  assert.deepEqual(fib.parseGuessNumTable(''), fib.DEFAULT_FIB_GUESS_NUM_TABLE, '空回默认')
  assert.deepEqual(fib.parseGuessNumTable('a,b'), fib.DEFAULT_FIB_GUESS_NUM_TABLE, '非法回默认')
  assert.deepEqual(fib.parseGuessNumTable([6, 7]), [6, 7], '接受数组')
  assert.equal(fib.guessNumLimit(1), 8)
  assert.equal(fib.guessNumLimit(2), 9)
  assert.equal(fib.guessNumLimit(7), 20)
  assert.equal(fib.guessNumLimit(50), 20, '超出表长取末值')
  assert.equal(fib.guessNumLimit(0), 8, '人数异常按 1')
})

// ===== 谜底池与猜测行 =====

test('buildFibPool：只收本局难度有谱面且定数在范围内的曲（排宴谱）', () => {
  assert.deepEqual(idsOf(fib.buildFibPool(3, null, null)), [100, 101, 102, 103], '无紫谱曲与宴谱不进池')
  assert.deepEqual(idsOf(fib.buildFibPool(3, 12.5, 14)), [100, 101, 102])
  assert.deepEqual(idsOf(fib.buildFibPool(4, null, null)), [103], '白谱局只有一首')
  assert.deepEqual(idsOf(fib.buildFibPool(3, 100, null)), [], '空范围 → 空池')
})

test('createFibRow：七列判定（谱师/Version/分类/类型/定数/BPM/物量）', () => {
  const ctx = { player: 'B', levelIndex: 3, nearVersion: 1, nearDs: 0.5, nearBpm: 20, nearNotes: 200 }
  const row = fib.createFibRow(SONGS[1], SONGS[0], ctx)
  assert.equal(row.hit, false)
  assert.equal(row.charter.state, 'same', '同谱师')
  assert.equal(row.version.state, 'near', '相邻代')
  assert.equal(row.version.arrow, 'down')
  assert.equal(row.version.sub, '暁')
  assert.equal(row.genre.state, 'same')
  assert.equal(row.type.state, 'same', '同为 SD')
  assert.equal(row.ds.state, 'near', '12.7 vs 12.5 差 0.2')
  assert.equal(row.ds.sub, '13')
  assert.equal(row.bpm.state, 'near', '155 vs 150')
  assert.equal(row.notes.state, 'near', '600 vs 500')
  assert.equal(row.notes.arrow, 'down')

  const row2 = fib.createFibRow(SONGS[0], SONGS[2], ctx)
  assert.equal(row2.charter.state, 'diff')
  assert.equal(row2.version.state, 'diff', '隔多代')
  assert.equal(row2.type.state, 'diff', 'SD vs DX')
  assert.equal(row2.ds.state, 'diff', '差 1.1 > 0.5')
  assert.equal(row2.notes.state, 'diff', '差 700 > 200')

  const row3 = fib.createFibRow(SONGS[4], SONGS[2], ctx)
  assert.equal(row3.charter.value, '—', '无紫谱 → 谱师未知')
  assert.equal(row3.ds.state, 'unknown')
  assert.equal(row3.notes.value, '—')
  assert.equal(row3.version.state, 'diff', '但版本列仍有值')
  assert.equal(row3.bpm.value, '120')

  assert.equal(fib.createFibRow(SONGS[2], SONGS[2], ctx).hit, true)
})

test('toRenderRows：列序固定且带 class', () => {
  const ctx = { player: 'B', levelIndex: 3, nearVersion: 1, nearDs: 0.5, nearBpm: 20, nearNotes: 200 }
  const [rendered] = fib.toRenderRows([fib.createFibRow(SONGS[0], SONGS[2], ctx)])
  assert.deepEqual(rendered.cells.map(c => c.cls), [
    'charterCell', 'versionCell', 'genreCell', 'typeCell', 'dsCell', 'bpmCell', 'notesCell',
  ])
})

// ===== 状态机 =====

/** 开局并免冷却（阈值是对局上的普通对象，测试直接改） */
function startLocal({ answer, levelIndex = 3, min = null, max = null } = {}) {
  const sent = []
  const game = fib.startFibGame(GID, {
    answer: answer ?? SONGS[0],
    levelIndex,
    min,
    max,
    send: async m => sent.push(m),
    starter: 1,
    starterName: 'starter',
  })
  game.cfg.selfCd = 0
  game.cfg.groupCd = 0
  return { game, sent }
}

test('guessFib 路由：非曲库放行、猜错出图、重复与多候选拦截', async () => {
  const { game, sent } = startLocal({ answer: SONGS[2] }) // 谜底 102，下列猜测均非答案
  assert.equal(g.isPlaying(GID), true)

  assert.equal(await fib.guessFib(GID, '今天天气不错', 'B', 2), false, '非曲库消息放行')
  assert.equal(sent.length, 0)
  assert.equal(await fib.guessFib(GID, '#mai help', 'B', 2), false, '命令前缀不放行')

  assert.equal(await fib.guessFib(GID, '100', 'B', 2), true, '猜错：消费并出对比表')
  assert.equal(game.rows.length, 1)
  assert.equal(sent.length, 1, '每次有效猜测一张图（渲染失败降级文案）')

  await fib.guessFib(GID, 'Orange Song', 'C', 3)
  assert.equal(game.rows.length, 1, '重复猜测不耗次数')
  assert.ok(String(sent.at(-1)).includes('猜过'))

  await fib.guessFib(GID, '橙歌', 'C', 3)
  assert.equal(game.rows.length, 1, '别名重复同样拦截')

  await fib.guessFib(GID, '多曲', 'C', 3)
  assert.equal(game.rows.length, 1, '别名命中多曲 → 提示用 id，不耗次数')
  assert.ok(String(sent.at(-1)).includes('多首'))

  await fib.guessFib(GID, '104', 'C', 3)
  assert.equal(game.rows.length, 2, '无紫谱的曲也可猜（列降级未知）')
})

test('guessFib：个人冷却拦截有效猜测', async () => {
  const { game, sent } = startLocal({ answer: SONGS[0] })
  game.cfg.selfCd = 0.2

  assert.equal(await fib.guessFib(GID, '101', 'B', 2), true)
  const rows = game.rows.length
  const sentCount = sent.length
  await fib.guessFib(GID, '102', 'B', 2)
  assert.equal(game.rows.length, rows, '冷却中不计次数')
  assert.ok(String(sent.at(-1)).includes('冷却'))
  await sleep(260)
  await fib.guessFib(GID, '102', 'B', 2)
  assert.equal(game.rows.length, rows + 1, '冷却过后可继续')
  assert.equal(sent.length, sentCount + 2, '冷却提示与对比表各一条')
  assert.ok(!String(sent.at(-1)).includes('冷却'))
})

test('猜中结算：揭晓带答案行并注销对局，结束后消息放行', async () => {
  const { game, sent } = startLocal({ answer: SONGS[0] })
  await fib.guessFib(GID, '101', 'B', 2)

  assert.equal(await fib.guessFib(GID, '100', 'C', 3), true)
  assert.equal(g.isPlaying(GID), false, '结算后注销对局')
  const last = sent.at(-1)
  const text = payloadText(last)
  assert.ok(text.includes('猜对了'), '结算文案（渲染失败降级为整串文本）')
  assert.ok(text.includes('「C」'), '文案含猜中者')
  assert.ok(!text.includes('Orange Plus'), '降级文案不含猜测曲（曲名在图内）')

  assert.equal(await fib.guessFib(GID, '101', 'B', 2), false, '已结束不再消费')
})

test('次数用尽结算：rows 达到人数对应上限即收尾', async () => {
  const { game, sent } = startLocal({ answer: SONGS[0] })
  game.cfg.guessNumTable = [2]

  await fib.guessFib(GID, '101', 'B', 2)
  assert.equal(g.isPlaying(GID), true)
  await fib.guessFib(GID, '102', 'C', 3)
  assert.equal(g.isPlaying(GID), false, '两人两猜用尽')
  assert.ok(payloadText(sent.at(-1)).includes('次数用尽'))
})

test('空闲超时自动揭晓；有效猜测重置计时', async () => {
  fib.setTimeScale(0.001) // 600s → 0.6s
  const { game, sent } = startLocal({ answer: SONGS[0] })

  await fib.guessFib(GID, '101', 'B', 2)
  await sleep(250)
  assert.equal(g.isPlaying(GID), true, '猜测重置了空闲计时（否则 0.6s 内早该结算）')

  await sleep(500)
  assert.equal(g.isPlaying(GID), false, '距上次猜测 0.75s 后超时收尾')
  assert.ok(payloadText(sent.at(-1)).includes('长时间没有新的猜测'))
})

test('finishGame 揭晓钩子：#mai ans 路径对 fib 出最终图', async () => {
  const { game } = startLocal({ answer: SONGS[0] })
  await fib.guessFib(GID, '101', 'B', 2)

  const parts = await g.finishGame(GID) // ans handler 内部即此调用
  assert.ok(parts, 'fib 有揭晓钩子')
  assert.equal(g.isPlaying(GID), false)
  assert.ok(payloadText(parts).includes('答案是'), '默认前缀')
  assert.equal(game.rows.length, 1)
})

test('startFibGame 返回的对局在共享注册表上（与其他游戏互斥）', async () => {
  startLocal({ answer: SONGS[0] })
  assert.equal(g.gameOf(GID)?.type, 'fib')
  assert.equal(g.endGame(GID)?.type, 'fib', 'endGame 能清掉 fib 对局')
  assert.equal(g.isPlaying(GID), false)
})
