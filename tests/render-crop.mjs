/** 猜曲绘裁片渲染冒烟：真取窗 → 真渲染，目检裁片是否确为曲绘局部 */
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
const { cropCover, pickCropWindow } = await import('../lib/render/crop.js')
console.log('取窗样例（400×400）:', JSON.stringify([0, 0.25, 0.5, 0.75, 1].map(r => pickCropWindow(400, 400, () => r))))
for (const id of [8, 1000]) {
  const buf = await cropCover(id)
  if (typeof buf === 'string') { console.error('渲染失败:', buf); process.exit(1) }
  const file = path.join(OUT, `crop-${id}.png`)
  fs.writeFileSync(file, buf)
  console.log('已写出', file, buf.length, 'bytes | JPEG 魔数:', buf.slice(0, 3).toString('hex'))
}
process.exit(0)
