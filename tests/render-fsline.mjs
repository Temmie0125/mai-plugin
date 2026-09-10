/**
 * 分数线海报渲染冒烟：真实曲库取曲 → fslineView → 宿主渲染
 * 运行：cd E:/bot/Yunzai && node plugins/mai-plugin/tests/render-fsline.mjs
 * 输出 tests/out/fsline.png（与样板目检对比）
 */
import fs from 'node:fs'
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
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })

const { mai } = await import('../lib/service.js')
const { fslineView, drawFsline } = await import('../lib/handler.js')
const { renderFsline } = await import('../lib/render/picmodle.js')

await mai.init({ network: false })
console.log('曲库:', mai.totalList.root.length, '曲')

// 挑一首 MASTER 有物量的曲（样板 demo 是 799）
const song = mai.totalList.byId(799) ?? mai.totalList.root.find(s => s.difficulties?.[3]?.notes?.tap > 0)
console.log('选曲:', song.song_id, song.song_name, '| 难度数:', song.difficulties.length)
const lv = Math.min(3, song.difficulties.length - 1)
console.log('难度:', song.difficulties[lv].level, '| notes:', JSON.stringify(song.difficulties[lv].notes))

const view = fslineView(song, lv)
console.log('物量:', JSON.stringify(view.counts))
const buf = await renderFsline(view)
if (typeof buf === 'string') { console.error('渲染失败:', buf); process.exit(1) }
const file = path.join(OUT, 'fsline.png')
fs.writeFileSync(file, buf)
console.log('已写出', file, buf.length, 'bytes | PNG 魔数:', buf.slice(0, 4).toString('hex'))
process.exit(0)
