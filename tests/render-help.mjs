/**
 * 渲染管线冒烟测试：模板 → art-template → 宿主 puppeteer screenshot → Buffer
 * 必须在 Yunzai 根目录运行（宿主渲染器的 temp/renderers 路径均相对 cwd）：
 *   node plugins/mai-plugin/tests/render-help.mjs
 * 输出 plugins/mai-plugin/tests/help.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 宿主渲染器/配置依赖全局 logger（app.js 注入，含 red/green 等颜色扩展方法）；独立运行用 Proxy 兜底
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(target, prop) {
      if (prop in console) return console[prop].bind(console)
      return (...args) => args.join(' ') // 任意扩展方法（mark/green/red...）静默拼接
    },
  })
}
if (!global.segment) {
  global.segment = { image: buf => ({ type: 'image', buffer: buf }) }
}
// 宿主 puppeteer browserInit 用全局 redis 缓存跨进程浏览器端点；独立运行打桩为内存 no-op
if (!global.redis) {
  const mem = new Map()
  global.redis = {
    async set(k, v) { mem.set(k, v); return 'OK' },
    async get(k) { return mem.get(k) ?? null },
    async del(...keys) { let n = 0; for (const k of keys) { mem.delete(k); n++ } return n },
  }
}

const { renderHelp } = await import('../lib/render/picmodle.js')

const t0 = Date.now()
const result = await renderHelp('mai', 'v0.1.0')

if (!Buffer.isBuffer(result)) {
  console.error('渲染失败：', result)
  process.exit(1)
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'help.jpg')
fs.writeFileSync(out, result)
console.log(`[ok] help.jpg ${ (result.length / 1024).toFixed(1) }KB ${Date.now() - t0}ms → ${out}`)

// JPEG 魔数校验（渲染默认 imgType:jpeg）
const magic = result.subarray(0, 3).toString('hex')
if (magic !== 'ffd8ff') {
  console.error('输出不是合法 JPEG，魔数：', magic)
  process.exit(1)
}
console.log('[ok] JPEG 魔数校验通过 · 渲染管线全通')
process.exit(0) // 宿主渲染器的 chokidar watcher 会保持事件循环，主动退出
