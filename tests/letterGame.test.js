/**
 * 开字母对局单测（状态机、互斥、多别名命中、空闲超时）
 *
 * 时序用 `setTimeScale(0.001)`（与 tests/guess.test.js 同款注入）；
 * 群开关与用户表走临时 dataRoot，绝不碰真机 data/。
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

const database = await import('../lib/database.js')
const service = await import('../lib/service.js')
const Config = (await import('../lib/config.js')).default
const { AliasList } = await import('../lib/merge/aliasList.js')
const g = await import('../lib/guess.js')
const B = await import('../lib/letterBoard.js')
const { MaiGuess, MaiGuessAnswer } = await import('../apps/guess.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const mark = s => String(s).replaceAll(B.HIDDEN, '*')

/** 曲库：标题覆盖拉丁/汉字/假名；曲 9 与曲 10 故意共用别名「同名」 */
/** 4 难度（guess 的 cluePool 取 difficulties[2]/[3]，故猜歌夹具需要真难度） */
const DIFFS = [0, 1, 2, 3].map(i => ({ level_index: i, level: '5', level_value: 5, stats: { cnt: 5000 } }))
const mkSong = (song_id, song_name, extra = {}) => ({
  song_id, song_name, artist: 'A', genre: '舞萌', bpm: 1, type: 'SD', version_str: 'm',
  difficulties: DIFFS.map(d => ({ ...d })), ...extra,
})

const SONGS = [
  mkSong(8, 'Today'),
  mkSong(9, '今日'),
  mkSong(10, 'ジングル'),
  mkSong(11, 'Song 2'),
  mkSong(12, '!!!'),
  mkSong(20, 'A'), // 单字曲：一次开字母即全开，用于「全部翻开自动收尾」
  mkSong(100001, '[協]宴', { genre: '宴会場', type: 'DX' }),
]
const ALIASES = [
  { song_id: 8, song_name: 'Today', alias: ['今天'] },
  { song_id: 9, song_name: '今日', alias: ['同名', 'きょう'] },
  { song_id: 10, song_name: 'ジングル', alias: ['同名'] }, // 与曲 9 共用别名：一条回答命中多行
  { song_id: 11, song_name: 'Song 2', alias: [] },
]

let root
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-letter-'))
  database.setDataRoot(root)
  service.setDataRoot(root)
  await database.load() // setDataRoot 只换目录、不清内存，需重建（同 tests/guessRules.test.js）
  service.mai.totalList = { root: SONGS, byId: id => SONGS.find(s => s.song_id === id) ?? null }
  service.mai.totalAliasList = AliasList.fromJSON(ALIASES)
  g.clearAllGames()
  g.setTimeScale(1)
})

after(() => {
  g.clearAllGames()
  g.setTimeScale(1)
  database.setDataRoot(path.resolve('data'))
  service.setDataRoot(path.resolve('data'))
})

const fakeInst = cls => {
  const inst = new cls()
  const replies = []
  inst.reply = async m => replies.push(m)
  return { inst, replies }
}
const mkE = (msg, { gid = 111, uid = 114514, admin = false } = {}) => ({
  msg, message: [], user_id: uid, isGroup: true, group_id: gid, isMaster: admin,
  member: { is_owner: admin, is_admin: admin },
  sender: { card: `用户${uid}` },
  reply: async () => {},
})
/** 开局（默认 4 首；用例若断言具体某曲，务必用 startExact 把候选定死） */
const start = (gid = 111, opts = {}) => g.startLetterGame(gid, {
  send: () => {}, starter: 114514, starterName: '发起者', count: 4, ...opts,
})

/**
 * 把曲库限成指定的几首再开局
 * `pickLetterSongs` 是**随机抽样**，凡是断言「某首歌在板面上」的用例都必须先把候选定死，
 * 否则会随抽样结果时红时绿（是本文件踩过的坑）
 */
const startExact = (songs, { gid = 111, ...opts } = {}) => {
  service.mai.totalList.root = songs
  return g.startLetterGame(gid, {
    send: () => {}, starter: 114514, starterName: '发起者', count: songs.length, ...opts,
  })
}

/** 临时覆盖配置跑一段（只改内存缓存，不写用户 yaml；同 tests/manage.test.js） */
async function withCfg(patch, fn) {
  try {
    Config.config.config = { ...Config.getConfig('config'), ...patch }
    return await fn()
  } finally {
    delete Config.config.config
  }
}

// ---------------------------------------------------------------------

test('配置：默认 8 首 / 空闲 300 秒；非法回退', () => {
  assert.deepEqual(g.resolveLetterConfig({}), {
    count: 8, revealCd: 0, guessCd: 0, tipCd: 0, idleTimeout: 300,
  })
  assert.deepEqual(
    g.resolveLetterConfig({
      letterSongCount: 12, letterIdleTimeout: 60, letterRevealCd: 5, letterGuessCd: 3, letterTipCd: 7,
    }),
    { count: 12, revealCd: 5, guessCd: 3, tipCd: 7, idleTimeout: 60 },
  )
  assert.equal(g.resolveLetterConfig({ letterSongCount: 1 }).count, 8, '低于下限回退')
})

test('抽题：排除宴谱与全符号标题、不重复、数量正确', () => {
  const songs = g.pickLetterSongs(4)
  assert.equal(songs.length, 4)
  assert.equal(new Set(songs.map(s => s.song_id)).size, 4, '不得重复')
  assert.ok(!songs.some(s => s.song_id >= 100000), '宴谱不进池')
  assert.ok(!songs.some(s => s.song_id === 12), '全符号标题「!!!」开不出来，不进池')
  assert.equal(g.pickLetterSongs(99), null, '池子不足时返回 null（交调用方给文案）')
})

test('开局：板面全是遮罩（空格保留），对局已登记', () => {
  const game = start()
  assert.ok(game)
  assert.equal(game.rows.length, 4)
  assert.equal(g.isPlaying(111), true)
  for (const row of game.rows) {
    assert.equal(row.blur, B.encrypt(row.song.song_name))
    assert.ok(mark(row.blur).includes('*'))
  }
  assert.equal(g.letterBoardText(game).includes('*'), true)
})

test('open：成功翻开 / 重复字母 / 不含该字母 三分支', async () => {
  const sent = []
  const game = startExact([SONGS[0], SONGS[1], SONGS[2], SONGS[3]], { send: m => sent.push(m) })
  const today = game.rows.find(r => r.song.song_name === 'Today')
  assert.ok(today, '候选定死后 Today 必在局中')

  assert.equal((await g.openLetter(111, 'T')).kind, 'opened', 'Today 含 T')
  assert.equal(mark(today.blur), 'T****')
  assert.equal((await g.openLetter(111, 'T')).kind, 'dup', '同一字母不重复开')
  // 用 Q 当「谁都不含」的样例：注意 Z 会命中 ジ（其多首字母 jz 同时收 ji/zi），不是 miss
  assert.equal((await g.openLetter(111, 'q')).kind, 'miss', '没有行含 Q')

  assert.ok(sent.some(m => m.includes('成功翻开字母[ T ]')))
  assert.ok(sent.some(m => m.includes('已经翻开过')))
  assert.ok(sent.some(m => m.includes('这几首曲目中不包含字母[ q ]')))
})

test('open：汉字按拼音、假名按罗马字（这是相对 phi 的净增）', async () => {
  const game = startExact([SONGS[1], SONGS[2]])
  const cn = game.rows.find(r => r.song.song_name === '今日')
  const jp = game.rows.find(r => r.song.song_name === 'ジングル')

  await g.openLetter(111, 'j') // 今(j) 与 ジ(jz) 同字母
  assert.equal(mark(cn.blur), '今*', '今日 2 字')
  assert.equal(mark(jp.blur), 'ジ***', 'ジングル 4 字')
})

test('排版：「已翻开」独占一行（不是同一行的全角空格）', async () => {
  const game = startExact([SONGS[0], SONGS[1], SONGS[2], SONGS[3]])
  await g.openLetter(111, 'T')

  const text = g.letterBoardText(game)
  assert.match(text, /首）\n已翻开\[/, '「已翻开」前必须是换行')
  assert.ok(!/首）　/.test(text), '不得再用全角空格接在同一行')
  // 板面行仍要完整（换行不能把行之间粘起来）
  assert.equal(text.split('\n').length, 2 + game.rows.length + 1, '标题行 + 已翻开行 + 空行 + 各行')
})

test('排版：结束时的答案列表是**一个字符串**且逐行换行', async () => {
  const sent = []
  const game = startExact([SONGS[0], SONGS[1]], { send: m => sent.push(m) })
  const parts = await g.finishGame(111)

  // 关键回归：返回纯文本数组时，宿主按消息段拼接**不加分隔符**，各行会粘成一坨
  assert.equal(typeof parts, 'string', '必须拼成单个字符串再发')
  const lines = parts.split('\n')
  assert.ok(lines.length >= game.rows.length, `答案应逐行：${JSON.stringify(lines)}`)
  for (const row of game.rows) {
    assert.ok(lines.some(l => l.includes(row.song.song_name)), `${row.song.song_name} 应独占一行`)
  }
})

test('直接发答案：命中单行；答错静默；大小写与别名都认', async () => {
  const sent = []
  const game = startExact([SONGS[0], SONGS[1], SONGS[2], SONGS[3]], { send: m => sent.push(m) })
  const row = game.rows.find(r => r.song.song_name === 'Today')
  const idx = game.rows.indexOf(row)

  assert.equal((await g.answerLetter(111, '这不是答案', '小明')).kind, 'miss', '答错静默')
  assert.equal(sent.length, 0, '答错不发送任何东西')

  assert.equal((await g.answerLetter(111, '  today  ', '小明')).kind, 'hit', '大小写与空白容忍')
  assert.equal(game.rows[idx].winner, '小明')
  assert.equal(game.rows[idx].blur, null, '已解出的行清空遮罩')
  assert.equal(sent.length, 1)
})

test('直接发答案：别名也算（含共用别名时一条命中多行，一次说清）', async () => {
  // 只抽到曲 9/10 才测得了（二者共用别名「同名」）
  service.mai.totalList.root = [SONGS[1], SONGS[2]]
  const sent = []
  const game = start(111, { send: m => sent.push(m), count: 2 })
  assert.deepEqual(game.rows.map(r => r.song.song_name).sort(), ['ジングル', '今日'])

  const r = await g.answerLetter(111, '同名', '小红')
  assert.equal(r.kind, 'solved', '两条都解出 ⇒ 直接收尾')
  assert.deepEqual(r.hits, [0, 1], '一条回答命中两行')
  assert.equal(sent.length, 1, '只回一次（把你说的「回复一次说清」落在这里）')
  const text = String(sent[0])
  assert.ok(text.includes('一次命中 2 首'), `应说明一次命中多首：${text}`)
  assert.ok(text.includes('今日') && text.includes('ジングル'))
})

test('tips：随机翻开一个字符，并把它记进「已翻开」', async () => {
  const sent = []
  const game = startExact([SONGS[0], SONGS[1], SONGS[2], SONGS[3]], { send: m => sent.push(m) })
  const before = game.rows.map(r => mark(r.blur)).join('|')

  const r = await g.tipLetter(111)
  assert.equal(r.kind, 'tip')
  assert.ok(r.symbol, '应回报翻开的是哪个字符')
  assert.ok(game.opened.size >= 1, '翻开的字符要记进 opened（否则 open 同字会重复翻）')
  assert.notEqual(game.rows.map(x => mark(x.blur)).join('|'), before, '板面应确有变化')
  assert.match(String(sent.at(-1)), /已随机翻开字符/)

  // 提示翻的是**字符**而非字母：候选来自仍隐藏的真实字符
  const B = await import('../lib/letterBoard.js')
  assert.ok(B.revealCandidates(game).length < 20, '候选池应随翻开而变小')
})

test('tips：候选为空时给引导（不再空翻）', async () => {
  // 曲名「A」：开局后只有一个隐藏位，用 tips 翻掉它即全开
  service.mai.totalList.root = [SONGS[5]]
  const sent = []
  const game = startExact([SONGS[5]], { send: m => sent.push(m) })
  assert.equal(game.rows.length, 1)

  const r = await g.tipLetter(111)
  assert.equal(r.kind, 'solved', '翻完最后一个字符应直接收尾')
  assert.equal(g.isPlaying(111), false)
})

test('tips：无对局时返回 null（由命令层给文案）', async () => {
  assert.equal(await g.tipLetter(999), null)
})

test('tips：受独立的 letterTipCd 约束（与开字母冷却分开）', async () => {
  await withCfg({ letterTipCd: 60 }, async () => {
    startExact([SONGS[0], SONGS[1], SONGS[2], SONGS[3]])
    assert.equal((await g.tipLetter(111)).kind, 'tip')
    assert.equal((await g.tipLetter(111)).kind, 'cooldown', '冷却内再要提示应被拒')
  })
})

test('tips：会重置空闲计时（用提示也算有人在玩）', async () => {
  database.updateGroup(111, { guess: true })
  g.setTimeScale(0.001) // 300s → 300ms
  startExact([SONGS[0], SONGS[1], SONGS[2], SONGS[3]])

  await sleep(150)
  assert.equal((await g.tipLetter(111)).kind, 'tip')
  await sleep(150) // 若未重置，此刻已超 300ms
  assert.equal(g.isPlaying(111), true, '用提示必须续命')
})

test('应答：对得上曲库但不在本局 → 给提示；完全对不上 → 静默', async () => {
  const sent = []
  const game = startExact([SONGS[0], SONGS[1]], { send: m => sent.push(m) })
  assert.equal(game.rows.length, 2)

  // 曲 11 通过别名「外曲别名」存在于曲库，但不在本局
  service.mai.totalAliasList = AliasList.fromJSON([{ song_id: 11, song_name: 'Song 2', alias: ['外曲别名'] }])
  assert.equal((await g.answerLetter(111, '外曲别名', '小明')).kind, 'elsewhere')
  assert.match(String(sent.at(-1)), /不在本局里/)

  sent.length = 0
  assert.equal((await g.answerLetter(111, '完全对不上的话', '小明')).kind, 'miss')
  assert.equal(sent.length, 0, '对不上任何真实曲目时必须静默（多半只是日常聊天）')

  // 数字 id 同样算「对得上曲库」（本用例把 totalList.root 缩到局内两首以固定抽样，
  // 故曲名路径查不到局外曲；id 走 byId、别名走 totalAliasList，二者不受 root 限制）
  sent.length = 0
  assert.equal((await g.answerLetter(111, '11', '小明')).kind, 'elsewhere', '数字 id 也算对得上曲库')
  assert.equal(sent.length, 1)
})

test('全部翻开自动收尾并揭晓', async () => {
  service.mai.totalList.root = [SONGS[5]] // 曲名「A」：一次开字母即全开
  const sent = []
  const game = start(111, { send: m => sent.push(m), count: 1 })
  assert.equal(game.rows.length, 1)

  const r = await g.openLetter(111, 'A')
  assert.equal(r.kind, 'solved')
  assert.equal(g.isPlaying(111), false, '收尾后应清理对局')
  assert.ok(String(sent.at(-1)).includes('A'), '揭晓里应含曲名')
})

test('空闲超时：按「距上次答对」计时，答对会重置', async () => {
  database.updateGroup(111, { guess: true }) // 开关关着时定时器只会静默清理、不发超时文案
  service.mai.totalList.root = [SONGS[0], SONGS[1]]
  g.setTimeScale(0.001) // 300s → 300ms
  const sent = []
  start(111, { send: m => sent.push(m), count: 2 })

  await sleep(150) // 未到 300ms
  assert.equal(g.isPlaying(111), true)

  // 中途答对一次 → 计时重置
  const r = await g.answerLetter(111, 'Today', '小明')
  assert.equal(r.kind, 'hit')
  await sleep(150) // 距上次答对 150ms（若未重置，此刻已超 300ms）
  assert.equal(g.isPlaying(111), true, '答对必须重置空闲计时')

  await sleep(250)
  assert.equal(g.isPlaying(111), false, '距上次答对满 300ms 后应收尾')
  assert.ok(sent.some(m => String(m).includes('怎么还没有人答对啊')), '超时文案')
  assert.ok(String(sent.at(-1)).includes('今日'), '揭晓要列出全部答案')
})

test('ans：群管可结束、发起者可结束、无关群友不可、无对局给文案', async () => {
  database.updateGroup(111, { guess: true })
  const { inst, replies } = fakeInst(MaiGuess)

  // 无对局
  await inst.ans(mkE('#mai ans'))
  assert.equal(replies.at(-1), '该群没有正在进行的游戏')

  // 发起者（uid 114514）可结束
  start(111, { send: () => {}, starter: 114514 })
  await inst.ans(mkE('#mai ans', { uid: 999, admin: true }))
  assert.equal(g.isPlaying(111), false, '群管可结束')

  // 发起者可结束
  start(111, { send: () => {}, starter: 777 })
  replies.length = 0
  await inst.ans(mkE('#mai ans', { uid: 777 }))
  assert.equal(g.isPlaying(111), false, '发起者可结束')

  // 无关群友不可
  start(111, { send: () => {}, starter: 777 })
  replies.length = 0
  await inst.ans(mkE('#mai ans', { uid: 555 }))
  assert.equal(g.isPlaying(111), true, '无关群友不得结束')
  assert.match(String(replies.at(-1)), /只有群管或本局发起者/)
  g.endGame(111)
})

test('ans 对猜歌同样有效（三类通用）', async () => {
  database.updateGroup(111, { guess: true })
  const { inst, replies } = fakeInst(MaiGuess)
  g.startTextGame(111, { song: SONGS[0], img: 'IMG', send: () => {}, card: async () => 'CARD' })
  await inst.ans(mkE('#mai ans', { uid: 999, admin: true }))
  assert.equal(g.isPlaying(111), false)
  assert.ok(replies.length >= 1)
})

test('互斥：一个群同时只能有一类游戏', async () => {
  database.updateGroup(111, { guess: true })
  const { inst, replies } = fakeInst(MaiGuess)

  start(111, { send: () => {} }) // 先开字母
  replies.length = 0
  await inst.startLetter(mkE('#mai 开字母'))
  assert.match(String(replies.at(-1)), /已有正在进行的游戏/)
  await inst.startGame(mkE('#mai 猜歌'), 'text')
  assert.match(String(replies.at(-1)), /已有正在进行的游戏/)
  await inst.startGame(mkE('#mai 猜曲绘'), 'pic')
  assert.match(String(replies.at(-1)), /已有正在进行的游戏/)

  // 反向：先猜歌，再起开字母应被拒
  g.endGame(111)
  g.startTextGame(111, { song: SONGS[0], img: 'IMG', send: () => {}, card: async () => 'CARD' })
  replies.length = 0
  await inst.startLetter(mkE('#mai 开字母'))
  assert.match(String(replies.at(-1)), /已有正在进行的游戏/)
  g.endGame(111)
})

test('答题兜底：开字母局中直接作答走开字母分支（与猜歌共用一条规则）', async () => {
  const { inst } = fakeInst(MaiGuessAnswer)
  const game = startExact([SONGS[0], SONGS[1], SONGS[2], SONGS[3]])
  const idx = game.rows.findIndex(r => r.song.song_name === 'Today')

  assert.equal(await inst.onAnswer(mkE('随便聊聊')), false, '未命中放行')
  assert.equal(g.isPlaying(111), true)
  assert.equal(await inst.onAnswer(mkE('Today')), true, '命中开字母')
  assert.equal(game.rows[idx].blur, null)
})
