/** 弗一把对比表渲染冒烟：构造对局视图 → 真渲染，目检版式（列宽/状态色/箭头/图例/答案行） */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, { get: (t, p) => (p in console ? console[p].bind(console) : (...a) => a.join(' ')) })
}
if (!global.segment) global.segment = { image: buf => ({ type: 'image', buffer: buf }) }
if (!global.redis) {
  const mem = new Map()
  global.redis = { async set(k, v) { mem.set(k, v); return 'OK' }, async get(k) { return mem.get(k) ?? null }, async del(...ks) { for (const k of ks) mem.delete(k); return ks.length } }
}
// 宿主 renderer loader 顶层引用 Bot（Cfg.makeLog 等），裸 node 下需最小桩
if (!global.Bot) global.Bot = { makeLog: () => {}, ada: {}, config: {} }
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })

const database = await import('../lib/database.js')
const service = await import('../lib/service.js')
const fib = await import('../lib/fib.js')
const { renderFib } = await import('../lib/render/picmodle.js')

/** 只生成 spec 给出的难度位次并保留下标（缺席位次 = 无此难度） */
const diffs = spec => {
  const arr = []
  for (const i of [0, 1, 2, 3, 4]) {
    if (!spec[i]) continue
    arr[i] = { level_index: i, level: spec[i].level, level_value: spec[i].ds, note_designer: spec[i].nd, notes: { total: spec[i].total } }
  }
  return arr
}

const SONGS = [
  { song_id: 11802, song_name: 'Max Burner', artist: 'Sampling Masters MEGAREO', genre: '舞萌', bpm: 195, type: 'DX', version_str: 'maimai でらっくす UNiVERSE', version_int: 22003, difficulties: diffs({ 3: { level: '13+', ds: 13.8, nd: 'Jack', total: 1482 } }) },
  { song_id: 89, song_name: 'Maxi', artist: 'NAOKI', genre: '音击&中二节奏', bpm: 154, type: 'SD', version_str: 'maimai ORANGE', version_int: 14000, difficulties: diffs({ 3: { level: '13+', ds: 13.6, nd: 'Jack', total: 953 } }) },
  { song_id: 403, song_name: 'Kingdom of Silence', artist: ' DETROX ', genre: '东方Project', bpm: 178, type: 'DX', version_str: 'maimai でらっくす PRiSM', version_int: 25002, difficulties: diffs({ 3: { level: '14', ds: 14.0, nd: '配置のお方', total: 1737 } }) },
  { song_id: 113, song_name: 'Heart Beating Ahead', artist: 'Yunosuke', genre: '流行&动漫', bpm: 160, type: 'DX', version_str: 'maimai でらっくす FESTiVAL', version_int: 23105, difficulties: diffs({ 4: { level: '13', ds: 13.0, nd: '白谱师', total: 890 } }) },
]

service.mai.totalList = { root: SONGS, byId: id => SONGS.find(s => s.song_id === id) ?? null }
database.setDataRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fib-render-')))

const game = fib.startFibGame(1, {
  answer: SONGS[2],
  levelIndex: 3, min: 12.5, max: 14,
  send: async () => {},
  starter: 1,
  starterName: '发起人',
})
const ctx = { levelIndex: 3, nearVersion: 1, nearDs: 0.5, nearBpm: 20, nearNotes: 200 }
game.rows.push(fib.createFibRow(SONGS[0], SONGS[2], { ...ctx, player: '阿明' }))
game.rows.push(fib.createFibRow(SONGS[1], SONGS[2], { ...ctx, player: '小红' }))
game.players.set(1, { name: '阿明', lastAt: 0 })
game.players.set(2, { name: '小红', lastAt: 0 })
game.lastGuessId = SONGS[1].song_id

const view = fib.buildFibView(game, { withAnswer: true })
const buf = await renderFib(view)
if (typeof buf === 'string') { console.error('渲染失败:', buf); process.exit(1) }
const file = path.join(OUT, 'fib.png')
fs.writeFileSync(file, buf)
console.log('已写出', file, buf.length, 'bytes | PNG 魔数:', buf.slice(0, 4).toString('hex'))
// 超时对局（0 猜测 + 答案行）也出一张，覆盖空表分支
const g2 = fib.startFibGame(2, { answer: SONGS[3], levelIndex: 4, min: null, max: null, send: async () => {}, starter: 1, starterName: '发起人' })
g2.cfg = { ...g2.cfg, nearVersion: 1 }
const view2 = fib.buildFibView(g2, { withAnswer: true })
const buf2 = await renderFib(view2)
if (typeof buf2 === 'string') { console.error('空表渲染失败:', buf2); process.exit(1) }
fs.writeFileSync(path.join(OUT, 'fib-empty.png'), buf2)
console.log('已写出 fib-empty.png', buf2.length, 'bytes')
process.exit(0)
