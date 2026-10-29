/**
 * 在线素材磁盘缓存（P2 实测项：宿主截图在在线图片未加载完时抓拍 → 半图/缺图；
 * 且每次渲染都等待网络拖慢响应——源插件同样受困）
 * 方案：渲染前把所有 http(s) 素材下载到 data/assets/<sha1>.<ext>（运行时目录，
 * gitignored），模板 src 替换为 file:// 本地路径——命中缓存后渲染零网络等待、无半图；
 * 首次访问下载一次（超时兜底保留原 URL，由模板 onerror 回退）。
 * 并发去重：同 URL 并发 ensure 共享一个 inflight Promise。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pluginRoot } from '../path.js'

const CACHE_DIR = path.join(pluginRoot, 'data', 'assets')
const DEFAULT_TIMEOUT = 10000
/** 失败负缓存冷却期：落雪游戏资源限频，失败后冷却期内不再发请求（成功缓存是永久落盘，不受此限） */
const FAIL_TTL = 10 * 60 * 1000

/** @type {Map<string, Promise<string|null>>} */
const inflight = new Map()
/** @type {Map<string, number>} url → 最近一次失败时间（内存负缓存，重启即清） */
const failedAt = new Map()

export function cacheKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex')
}

/** URL pathname 扩展名（默认 .png），白名单防路径注入 */
export function extOf(url) {
  try {
    const name = new URL(url).pathname.split('/').pop() || ''
    const m = /\.([a-z0-9]{2,4})$/i.exec(name)
    return m ? `.${m[1].toLowerCase()}` : '.png'
  } catch {
    return '.png'
  }
}

function fileUrl(key, ext) {
  const p = path.join(CACHE_DIR, key + ext)
  return `file:///${p.replace(/\\/g, '/')}`
}

function cachedPath(key, ext) {
  return path.join(CACHE_DIR, key + ext)
}

/**
 * 确保 URL 已本地缓存；返回 file:// 本地 URL；失败/超时返回 null（调用方保留原 URL）
 * @param {string} url
 * @param {{timeout?: number, fetchImpl?: Function}} [opts] fetchImpl 供单测注入
 */
export async function ensure(url, { timeout = DEFAULT_TIMEOUT, fetchImpl = null } = {}) {
  const key = cacheKey(url)
  const ext = extOf(url)
  const target = cachedPath(key, ext)
  if (fs.existsSync(target)) {
    failedAt.delete(url)
    return fileUrl(key, ext)
  }

  const failed = failedAt.get(url)
  if (failed && Date.now() - failed < FAIL_TTL) return null

  if (inflight.has(url)) return inflight.get(url)
  const task = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      const res = await (fetchImpl ?? fetch)(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const tmp = target + '.tmp'
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, target)
      failedAt.delete(url)
      return fileUrl(key, ext)
    } catch {
      failedAt.set(url, Date.now())
      return null
    } finally {
      clearTimeout(timer)
      inflight.delete(url)
    }
  })()
  inflight.set(url, task)
  return await task
}

/**
 * images[] 之外的裸图片字段：模板 <img> 直引、不经 images 循环的（fsline 的 coverSrc、fib 的 bgCover）
 */
const BARE_FIELDS = ['coverSrc', 'bgCover']

/**
 * 遍历视图数据中的图片元素，把 http(s) src/fallback 全部缓存为本地 file:// URL
 * （同步结构视图里 images 为顶层数组；无 images 的页面仅处理裸字段，原样返回其余）
 * @param {object} data renderer.img 的模板数据
 */
export async function ensureLocalAssets(data) {
  if (!data) return data
  const urls = new Set()
  const collect = v => { if (typeof v === 'string' && /^https?:/i.test(v)) urls.add(v) }
  for (const im of data.images ?? []) {
    collect(im?.src)
    collect(im?.fallback)
  }
  for (const f of BARE_FIELDS) collect(data[f])
  if (!urls.size) return data
  // 并发下载（页面内在线素材量小：b50 ≤2；单 URL 内部已 inflight 去重）
  const results = await Promise.allSettled([...urls].map(async u => ({ url: u, local: await ensure(u) })))
  const map = new Map()
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.local) map.set(r.value.url, r.value.local)
  }
  for (const im of data.images ?? []) {
    if (!im) continue
    if (im.src && map.has(im.src)) im.src = map.get(im.src)
    else if (im.fallback && /^https?:/i.test(im.src ?? '')) {
      // 下载失败：就地降级到 fallback，不再把在线 URL 留给浏览器重发一次（限频源禁二连击）
      im.src = map.get(im.fallback) ?? im.fallback
      delete im.fallback
    }
    if (im.fallback && map.has(im.fallback)) im.fallback = map.get(im.fallback)
  }
  for (const f of BARE_FIELDS) {
    if (typeof data[f] === 'string' && map.has(data[f])) data[f] = map.get(data[f])
  }
  return data
}
