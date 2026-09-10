/**
 * 猜歌规则层单测（P3d，实施文档 §4.1）
 *
 * 重点是 **D5**：起手必须带命令头（裸「猜歌」/「猜曲绘」一律拒收，防日常误触发），
 * 而**答题兜底仍免前缀**，靠「仅当该群在游戏中才消费，否则 return false」压缩误触发窗口。
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
const { AliasList } = await import('../lib/merge/aliasList.js')
const g = await import('../lib/guess.js')
const { MaiGuess, MaiGuessAnswer } = await import('../apps/guess.js')

const rulesOf = cls => new MaiGuess().constructor === cls
  ? new cls().rule.map(r => ({ fnc: r.fnc, perm: r.permission, reg: new RegExp(r.reg) }))
  : null

const SONG = {
  song_id: 8, song_name: 'True Love Song', artist: 'Kai', genre: '舞萌', bpm: 150,
  type: 'SD', version_str: 'maimai',
  difficulties: [0, 1, 2, 3].map(i => ({ level_index: i, level: '5', stats: { cnt: 5000 } })),
}

let root
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-guessrules-'))
  database.setDataRoot(root)
  service.setDataRoot(root)
  // ⚠️ setDataRoot 只换目录，**不清内存 `groupDb`**（上个用例的群开关会残留）——
  // 必须再 load 一次把内存态从（空）临时目录重建，与 tests/groupSwitch.test.js 同款
  await database.load()
  service.mai.totalList = { root: [SONG], byId: () => SONG }
  service.mai.totalAliasList = AliasList.fromJSON([{ song_id: 8, song_name: 'True Love Song', alias: ['真爱'] }])
  g.clearAllGames()
  g.setTimeScale(1)
})

after(() => {
  g.clearAllGames()
  g.setTimeScale(1)
  database.setDataRoot(path.resolve('data'))
  service.setDataRoot(path.resolve('data'))
})

const mkInst = cls => {
  const inst = new cls()
  const replies = []
  inst.reply = async m => replies.push(m)
  return { inst, replies }
}
const mkE = (msg, gid = 111) => ({
  msg, message: [], user_id: 114514, isGroup: true, group_id: gid, isMaster: false, reply: async () => {},
})

// ---------------------------------------------------------------------

test('规则：起手命中（带命令头）；D5 —— 裸「猜歌」「猜曲绘」必须拒收', () => {
  const rules = new MaiGuess().rule.map(r => ({ fnc: r.fnc, reg: new RegExp(r.reg) }))
  const hit = (msg, fnc) => rules.find(r => r.fnc === fnc).reg.test(msg)

  for (const msg of ['#mai guess', '/mai guess', '#mai 猜歌', '#mai   guess ']) {
    assert.ok(hit(msg, 'startText'), `应命中 guess：${msg}`)
    assert.ok(!hit(msg, 'startPic'), `不应误入猜曲绘：${msg}`)
  }
  for (const msg of ['#mai guessill', '#mai 猜曲绘']) {
    assert.ok(hit(msg, 'startPic'), `应命中 guessill：${msg}`)
    assert.ok(!hit(msg, 'startText'), `不应误入猜歌：${msg}`)
  }
  // D5：无命令头一律不命中（这正是本批刻意移除的免前缀形态）
  for (const msg of ['猜歌', '猜曲绘', ' guess', '来猜歌', '#phi 猜歌', '#mai 猜歌了']) {
    assert.ok(!hit(msg, 'startText') && !hit(msg, 'startPic'), `应拒收：${msg}`)
  }
})

test('规则：on|off|reset 的两种写法（子命令与中文），且限群管', () => {
  const rule = new MaiGuess().rule.find(r => r.fnc === 'toggle')
  assert.equal(rule.permission, 'admin', '群开关限群管')
  const reg = new RegExp(rule.reg)
  const cases = [
    ['#mai guess on', 'on'], ['#mai guess off', 'off'], ['#mai guess reset', 'reset'],
    ['#mai 开启猜歌', '开启'], ['#mai 关闭猜歌', '关闭'], ['#mai 重置猜歌', '重置'],
  ]
  for (const [msg, want] of cases) {
    const m = msg.match(reg)
    assert.ok(m, `应命中：${msg}`)
    assert.equal(m[1] ?? m[2], want)
  }
  for (const msg of ['#mai guess', '#mai 猜歌 on', '#mai guess on now', 'guess on']) {
    assert.ok(!reg.test(msg), `不应命中：${msg}`)
  }
})

test('规则：开字母三条（起手 / 翻开 / 通用结束）命中与拒收', () => {
  const rules = new MaiGuess().rule.map(r => ({ fnc: r.fnc, perm: r.permission, reg: new RegExp(r.reg) }))
  const hit = (msg, fnc) => rules.find(r => r.fnc === fnc).reg.test(msg)

  for (const msg of ['#mai 开字母', '#mai letter', '#mai ltr', '/mai 开字母']) {
    assert.ok(hit(msg, 'startLetter'), `应命中起手：${msg}`)
  }
  for (const msg of ['#open J', '#open ジ', '#mai open J', '#出J', '#开J', '#翻开 A', '/open 2']) {
    assert.ok(hit(msg, 'open'), `应命中翻开：${msg}`)
  }
  for (const msg of ['#mai ans', '#mai 答案', '/mai ans']) {
    assert.ok(hit(msg, 'ans'), `应命中通用结束：${msg}`)
  }

  // 起手与翻开互不吃：`开字母` 在 `开` 之后还剩两字，故只落在起手上
  assert.ok(!hit('#mai 开字母', 'open'), '起手不应被翻开规则吃掉')
  assert.ok(!hit('#mai 开字母表', 'startLetter'), '多字命令不该命中')
  assert.ok(!hit('#open JJ', 'open'), '一次只开一个字母')
  assert.ok(!hit('#mai open', 'open'), '不给字母不命中')
  // 不吃他人命令 / 不吃自己别的命令
  for (const msg of ['#phi open J', '#phi ans', '#mai sync', '#mai guess']) {
    assert.ok(!hit(msg, 'open') && !hit(msg, 'ans') && !hit(msg, 'startLetter'), `不应命中：${msg}`)
  }
  // ans 必须**不带** permission：否则本局发起者会被规则层直接拦死
  assert.equal(rules.find(r => r.fnc === 'ans').perm, undefined, 'ans 的权限必须在 handler 内判')
})

test('规则：答题兜底 priority 200（排在主命令之后）+ log:false + 匹配一切', () => {
  const inst = new MaiGuessAnswer()
  assert.equal(inst.priority, 200, '必须晚于 priority 100 的主命令，否则会吃掉查歌等命令')
  assert.equal(inst.rule[0].log, false)
  assert.ok(new RegExp(inst.rule[0].reg).test('任意聊天内容'))
  assert.ok(new RegExp(inst.rule[0].reg).test('真爱'))
})

test('答题兜底：不在局中的群一律 return false 放行（不吞无关聊天）', async () => {
  const { inst, replies } = mkInst(MaiGuessAnswer)
  assert.equal(await inst.onAnswer(mkE('今天天气不错')), false)
  assert.equal(replies.length, 0, '不该有任何回复')
})

test('答题兜底：私聊一律 return false', async () => {
  const { inst, replies } = mkInst(MaiGuessAnswer)
  const e = { ...mkE('真爱'), isGroup: false }
  assert.equal(await inst.onAnswer(e), false)
  assert.equal(replies.length, 0)
})

test('答题兜底：答错静默放行、答对出卡并结束对局', async () => {
  database.updateGroup(111, { guess: true })
  const { inst, replies } = mkInst(MaiGuessAnswer)

  g.startTextGame(111, { song: SONG, img: 'IMG', send: () => {}, card: async () => 'CARD' })
  try {
    assert.equal(await inst.onAnswer(mkE('不是这个')), false, '答错应静默放行')
    assert.equal(replies.length, 0, '答错不回复（源没有 else 分支）')
    assert.ok(g.isPlaying(111), '答错不结束对局')

    const { drawChartInfo } = await import('../lib/handler.js')
    const orig = drawChartInfo
    // 出卡走真渲染代价大，这里只锁「正确路径返回 true 且结束对局」
    assert.equal(await inst.onAnswer(mkE('tls'.toUpperCase() === 'TLS' ? '真爱' : '')), true)
    assert.equal(g.isPlaying(111), false, '答对应结束对局')
    assert.equal(replies.length, 1, '答对应回一条')
  } finally {
    g.endGame(111)
  }
})

test('群开关：未开启的群起手被拒并给引导（白名单语义）', async () => {
  const { inst, replies } = mkInst(MaiGuess)
  // 未设置过的群 → guess 默认 false
  assert.equal(await inst.startGame(mkE('#mai 猜歌'), 'text'), true)
  assert.match(String(replies.at(-1)), /该群已关闭猜歌功能/)
  assert.match(String(replies.at(-1)), /#mai guess on/, '引导应给本插件语法，而非源的「开启mai猜歌」')
})

test('群开关：on/off/reset 的写入与回执（源文案逐字）', async () => {
  const { inst, replies } = mkInst(MaiGuess)

  await inst.toggle(mkE('#mai guess on'))
  assert.equal(database.getGroup(111).guess, true)
  assert.equal(replies.at(-1), '群猜歌功能已开启')

  await inst.toggle(mkE('#mai 重置猜歌'))
  assert.equal(replies.at(-1), '该群未处在猜歌状态', '没在局中时 reset 的源文案')

  g.startTextGame(111, { song: SONG, img: 'IMG', send: () => {}, card: async () => 'CARD' })
  await inst.toggle(mkE('#mai 重置猜歌'))
  assert.equal(replies.at(-1), '已重置该群猜歌')
  assert.equal(g.isPlaying(111), false)

  await inst.toggle(mkE('#mai guess off'))
  assert.equal(database.getGroup(111).guess, false)
  assert.equal(replies.at(-1), '群猜歌功能已关闭')
})

test('起手：已在局中时回统一文案（源只提两类，第三类落地后必然失真）', async () => {
  database.updateGroup(111, { guess: true })
  const { inst, replies } = mkInst(MaiGuess)
  g.startTextGame(111, { song: SONG, img: 'IMG', send: () => {}, card: async () => 'CARD' })
  try {
    await inst.startGame(mkE('#mai 猜曲绘'), 'pic')
    // 源原文案是「该群已有正在进行的猜歌或猜曲绘」；加了开字母后它就不再准确，
    // 故统一为三类通用文案并给出退路（#mai ans）。已登记为实施订正。
    assert.match(String(replies.at(-1)), /已有正在进行的游戏/)
    assert.match(String(replies.at(-1)), /开字母/, '文案要覆盖第三类')
    assert.match(String(replies.at(-1)), /#mai ans/, '要给退路')
  } finally { g.endGame(111) }
})
