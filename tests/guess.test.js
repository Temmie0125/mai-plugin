/**
 * 猜歌 / 猜曲绘 单测（P3d，设计 §4.2 状态机 + 实施文档 §4）
 *
 * 时序用 `setTimeScale(0.001)` 把整局 82 秒压到 ~82ms（与 `setDataRoot` 同款测试注入）。
 * 群开关走 `database.setDataRoot(mkdtemp)`，绝不碰真机 data/。
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

const SONGS = [
  { song_id: 8, song_name: 'True Love Song', artist: 'Kai', genre: '舞萌', bpm: 150, type: 'SD', version_str: 'maimai', difficulties: [0, 1, 2, 3].map(i => ({ level_index: i, level: String(5 + i), stats: { cnt: 5000 } })) },
  { song_id: 9, song_name: '冷门曲', artist: 'X', genre: '舞萌', bpm: 100, type: 'SD', version_str: 'maimai', difficulties: [0, 1, 2, 3].map(i => ({ level_index: i, level: '5', stats: { cnt: 1 } })) },
  { song_id: 100001, song_name: '宴谱', artist: 'X', genre: '宴会場', bpm: 100, type: 'DX', version_str: 'maimai', difficulties: [{ level_index: 0, level: '5', stats: { cnt: 99999 } }] },
  { song_id: 200, song_name: '只有三难度', artist: 'X', genre: '舞萌', bpm: 100, type: 'DX', version_str: 'maimai', difficulties: [0, 1, 2].map(i => ({ level_index: i, level: '5', stats: { cnt: 99999 } })) },
  { song_id: 300, song_name: '无统计', artist: 'X', genre: '舞萌', bpm: 100, type: 'DX', version_str: 'maimai', difficulties: [0, 1, 2, 3].map(i => ({ level_index: i, level: '5', stats: null })) },
]

let root
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-guess-'))
  database.setDataRoot(root)
  service.setDataRoot(root)
  service.mai.totalList = {
    root: SONGS,
    byId: id => SONGS.find(s => s.song_id === id) ?? null,
  }
  // 别名：TLS 故意大写，用来锁「答案集两侧都小写」
  service.mai.totalAliasList = AliasList.fromJSON([
    { song_id: 8, song_name: 'True Love Song', alias: ['真爱', 'TLS'] },
  ])
  g.clearAllGames()
  g.setTimeScale(1)
})

after(() => {
  g.clearAllGames()
  g.setTimeScale(1)
  database.setDataRoot(path.resolve('data'))
  service.setDataRoot(path.resolve('data'))
})

// ---------------------------------------------------------------------

test('曲子池：只收 ≤99999 且至少 4 难度且热度 > 10000 的曲', () => {
  assert.equal(g.rebuildGuessPool(), 1, '只有曲 8 同时满足（5×4 项 5000=20000）')
  assert.deepEqual(g.getHotIds(), [8])

  // 边界：热度恰好 10000 不算（源是严格大于）
  const edge = { song_id: 400, song_name: 'E', artist: '', genre: '', bpm: 1, type: 'SD', version_str: 'm', difficulties: [0, 1, 2, 3].map(i => ({ level_index: i, level: '5', stats: { cnt: 2500 } })) }
  service.mai.totalList.root = [...SONGS, edge]
  g.rebuildGuessPool()
  assert.ok(!g.getHotIds().includes(400), '恰好 10000 不应入池')
  edge.difficulties[0].stats.cnt = 2501
  g.rebuildGuessPool()
  assert.ok(g.getHotIds().includes(400), '10001 应入池')
})

test('曲子池：重复重建不累积（源的 hot_music_ids 只追加不清空，属源缺陷）', () => {
  g.rebuildGuessPool()
  g.rebuildGuessPool()
  g.rebuildGuessPool()
  assert.deepEqual(g.getHotIds(), [8], '三次重建结果应一致')
})

test('答案集 = 全别名（两侧小写）+ 数字 id；含大写的别名也能猜中', () => {
  const answer = g.buildAnswer(8)
  assert.ok(answer.has('tls'), '大写别名 TLS 应能以小写命中')
  assert.ok(answer.has('真爱'))
  assert.ok(answer.has('8'), '数字 id 也在答案集里')
  assert.ok(!answer.has('TLS'), '集合内应已归一小写')
})

test('判定：trim + 小写后的精确相等；答错/空/截断一律不中', () => {
  service.mai.totalList.byId = () => SONGS[0]
  g.startTextGame(1, { song: SONGS[0], img: 'IMG', send: () => {}, card: async () => 'CARD' })
  try {
    assert.equal(g.isCorrect(1, '  真爱  '), true, '前后空格应容忍')
    assert.equal(g.isCorrect(1, 'tls'), true, '大小写不敏感')
    assert.equal(g.isCorrect(1, '8'), true, '数字 id')
    assert.equal(g.isCorrect(1, '真爱曲'), false, '不含包含匹配')
    assert.equal(g.isCorrect(1, ''), false)
    assert.equal(g.isCorrect(999, '真爱'), false, '该群不在局中')
  } finally { g.endGame(1) }
})

test('特征模板：逐字照搬源的 8 条，抽 6 条互不重复', () => {
  const pool = g.cluePool(SONGS[0])
  assert.deepEqual(pool, [
    '的 Expert 难度是 7',
    '的 Master 难度是 8',
    '的分类是 舞萌',
    '的版本是 maimai',
    '的艺术家是 Kai',
    '不是 DX 谱面',
    '没有白谱',
    '的 BPM 是 150',
  ])
  const dx = g.cluePool({ ...SONGS[0], type: 'DX', difficulties: [0, 1, 2, 3, 4].map(i => ({ level_index: i, level: '5' })) })
  assert.ok(dx.includes('是 DX 谱面'), 'DX 谱面不加「不」')
  assert.ok(dx.includes('有白谱'), '5 难度不加「没」')

  const picked = g.buildClues(SONGS[0])
  assert.equal(picked.length, 6)
  assert.equal(new Set(picked).size, 6, '不放回抽样，互不重复')
  for (const c of picked) assert.ok(pool.includes(c), '抽出的必须来自模板池')
})

test('时序配置：默认 15 秒间隔 / 30 秒揭晓；非法值回退并告警', () => {
  assert.deepEqual(g.resolveTiming({}), { interval: g.DEFAULT_ROUND_INTERVAL, timeout: g.DEFAULT_REVEAL_TIMEOUT })
  assert.deepEqual(g.resolveTiming({ guessRoundInterval: 20, guessRevealTimeout: 45 }), { interval: 20, timeout: 45 })
  // 低于下限 → 回退（间隔下限 8 是源的值；默认 15 是为避开每分钟 5 条限额）
  assert.deepEqual(g.resolveTiming({ guessRoundInterval: 3, guessRevealTimeout: 1 }), { interval: 15, timeout: 30 })
  assert.deepEqual(g.resolveTiming({ guessRoundInterval: 'abc', guessRevealTimeout: null }), { interval: 15, timeout: 30 })
  assert.equal(g.DEFAULT_ROUND_INTERVAL, 15, '默认必须是 15：8 秒会让一局在任一 60 秒窗口内发出 7 条，撞每分钟 5 条限额')
})

test('整局猜歌：默认时序下 9 条消息、峰值不超 4 条/分（限额安全）', async () => {
  database.updateGroup(1, { guess: true })
  g.setTimeScale(0.001) // 120s → ~120ms
  const sent = []
  g.startTextGame(1, {
    song: SONGS[0], img: 'IMG',
    send: m => sent.push(m),
    card: async () => ['CARD', 'MESSAGE'],
  })

  await sleep(160)
  assert.equal(sent.length, 9, 'banner + 6 轮 + 第 7 轮 + 揭晓 = 9 条')
  assert.equal(sent[0], g.textBanner(g.DEFAULT_ROUND_INTERVAL), '起手文案里的间隔数应与配置一致')
  assert.match(sent[0], /每隔15秒/)
  for (let i = 0; i < 6; i++) {
    assert.match(sent[1 + i], new RegExp(`^${i + 1}/7 这首歌`), `第 ${i + 1} 轮`)
  }
  assert.deepEqual(sent[7], [g.TEXT_ROUND7, 'IMG', g.textRound7Tail(30)], '第 7 轮带裁片')
  assert.deepEqual(sent[8], [g.TEXT_REVEAL, 'CARD', 'MESSAGE'], '揭晓 = 文案 + 揭晓卡')
  assert.equal(g.isPlaying(1), false, '揭晓后对局应已清理')

  // 限额安全闸：按真实秒推出 9 条的发送时刻，任一 60 秒窗口内都不得超过 5 条
  // （这正是把间隔从源的 8 秒改成默认 15 秒的原因：8 秒时 t=4/12/20/28/36/44/52 一个窗口就 7 条）
  const sendTimes = [0, ...[1, 2, 3, 4, 5, 6, 7].map(i => g.DEFAULT_ROUND_INTERVAL * i), g.DEFAULT_ROUND_INTERVAL * 7 + 30]
  for (const t of sendTimes) {
    const n = sendTimes.filter(s => s >= t && s < t + 60).length
    assert.ok(n <= 5, `自第 ${t} 秒起的 60 秒内 ${n} 条，超出每分钟 5 条限额`)
  }
})

test('整局猜曲绘：发裁片后按配置的揭晓等待收尾', async () => {
  database.updateGroup(2, { guess: true })
  g.setTimeScale(0.001)
  const sent = []
  g.startPicGame(2, { song: SONGS[0], img: 'CROP', send: m => sent.push(m), card: async () => 'CARD' })

  await sleep(60)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0], [g.TEXT_PIC, 'CROP', g.textPicTail(30)])
  assert.deepEqual(sent[1], [g.TEXT_REVEAL, 'CARD'])
  assert.equal(g.isPlaying(2), false)
})

test('答对提前结束：清掉后续定时器，不再揭晓', async () => {
  database.updateGroup(3, { guess: true })
  g.setTimeScale(0.001)
  const sent = []
  g.startTextGame(3, { song: SONGS[0], img: 'IMG', send: m => sent.push(m), card: async () => 'CARD' })

  await sleep(12) // 已过 banner + 前两轮
  const before = sent.length
  assert.ok(before > 0 && before < 9, `应处在中途（实际 ${before} 条）`)
  const parts = await g.finishCorrect(3)
  assert.deepEqual(parts, [g.TEXT_CORRECT, 'CARD'])
  assert.equal(g.isPlaying(3), false)

  await sleep(120)
  assert.equal(sent.length, before, '结束后不得再有定时器输出')
})

test('reset / off 清定时器；off 还会拆掉进行中的一局', async () => {
  database.updateGroup(4, { guess: true })
  g.setTimeScale(0.001)
  const sent = []
  g.startTextGame(4, { song: SONGS[0], img: 'IMG', send: m => sent.push(m), card: async () => 'CARD' })
  await sleep(12)
  const before = sent.length

  assert.ok(g.endGame(4), 'reset 应移除对局')
  assert.equal(g.endGame(4), null, '再 reset 应返回 null（该群未处在猜歌状态）')
  await sleep(120)
  assert.equal(sent.length, before, 'reset 后不得再有输出')
})

test('群开关关掉后：下一个 tick 自动中止并清理（逐 tick 重校验）', async () => {
  database.updateGroup(5, { guess: true })
  g.setTimeScale(0.001)
  const sent = []
  g.startTextGame(5, { song: SONGS[0], img: 'IMG', send: m => sent.push(m), card: async () => 'CARD' })
  await sleep(2) // 让 banner（0ms）过去
  database.updateGroup(5, { guess: false })

  await sleep(120)
  assert.equal(g.isPlaying(5), false, '开关关掉后应被自动清理')
  // banner 已发（发在开关关闭之前），但后续轮次不应再发
  assert.ok(sent.length <= 1, `开关关闭后不应继续广播（实际 ${sent.length} 条）`)
})

test('揭晓卡失败降级：出卡返回文案时原样发出，不抛', async () => {
  database.updateGroup(6, { guess: true })
  g.setTimeScale(0.001)
  const sent = []
  g.startPicGame(6, { song: SONGS[0], img: 'CROP', send: m => sent.push(m), card: async () => '渲染失败文案' })
  await sleep(60)
  assert.deepEqual(sent[1], [g.TEXT_REVEAL, '渲染失败文案'])
})

test('取窗：恒落在图内且尺度在源的范围（0.15–0.4）', () => {
  // pickCropWindow 在 lib/render/crop.js（纯几何），此处按需载入避免拉入渲染链
  return import('../lib/render/crop.js').then(({ pickCropWindow }) => {
    for (const [W, H] of [[400, 400], [256, 256], [512, 512], [300, 500]]) {
      for (let i = 0; i <= 20; i++) {
        const r = i / 20
        const w = pickCropWindow(W, H, () => r)
        assert.ok(w.x >= 0 && w.y >= 0, `起点非负：${JSON.stringify(w)}`)
        assert.ok(w.x + w.w <= W && w.y + w.h <= H, `不越界：${JSON.stringify(w)}`)
        assert.ok(w.w >= Math.floor(W * 0.15) && w.w <= Math.ceil(W * 0.4), `宽度在源尺度内：${w.w}`)
      }
    }
    // 极端随机值不应产出空窗口
    assert.ok(pickCropWindow(400, 400, () => 0).w >= 1)
    assert.ok(pickCropWindow(400, 400, () => 1).w >= 1)
  })
})
