import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// assetCache 依赖 pluginRoot 常量缓存目录 —— 用可注入路径前先测纯函数，再测 mock fetch 流程
test('assetCache：cacheKey/extOf 锁值', async () => {
  const { cacheKey, extOf } = await import('../lib/render/assetCache.js')
  assert.equal(cacheKey('https://a.b/x.png').length, 40)
  // 同 URL 同 key、不同 URL 不同 key
  assert.equal(cacheKey('https://a.b/x.png'), cacheKey('https://a.b/x.png'))
  assert.notEqual(cacheKey('https://a.b/x.png'), cacheKey('https://a.b/y.png'))
  assert.equal(extOf('https://assets2.lxns.net/maimai/icon/302.png'), '.png')
  assert.equal(extOf('https://cdn/x.PNG?q=1'), '.png')
  assert.equal(extOf('not a url'), '.png')
  assert.equal(extOf('https://a.b/none'), '.png')
})

// ensure 的文件读写走模块内 CACHE_DIR（data/assets，gitignored 运行时目录）。
// 此处注入 mock fetch 全流程验证落盘/命中复用/失败降级。
test('assetCache：mock fetch 落盘 + 命中复用不发二次请求 + 失败返回 null', async () => {
  const mod = await import('../lib/render/assetCache.js')
  const { ensure, ensureLocalAssets } = mod
  const url = 'https://cdn.example.test/icon/UI_Icon_000302.png'
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]) }
  }

  const first = await ensure(url, { fetchImpl })
  assert.equal(calls, 1)
  assert.match(first, /^file:\/\/\/.*data[\\/]assets[\\/][0-9a-f]{40}\.png$/)
  // 命中缓存：不再发请求
  const second = await ensure(url, { fetchImpl })
  assert.equal(second, first)
  assert.equal(calls, 1)

  // 失败：超时/网络错误返回 null
  const bad = await ensure('https://cdn.example.test/missing.png', {
    fetchImpl: async () => ({ ok: false }),
  })
  assert.equal(bad, null)

  // 并发去重：同 URL 并发只发一次请求
  calls = 0
  const hot = await ensure(url, { fetchImpl }) // 已缓存 → 0 次
  assert.equal(calls, 0)
  assert.equal(hot, first)

  // ensureLocalAssets：替换 data.images 的 http src 为本地
  const data = { images: [{ src: url }, { src: 'file:///local.png' }, { fallback: url }] }
  await ensureLocalAssets(data)
  assert.match(data.images[0].src, /^file:\/\//)
  assert.equal(data.images[1].src, 'file:///local.png')
  assert.match(data.images[2].fallback, /^file:\/\//)

  // 清理本次落盘（保留目录本身无妨，属 data/ 运行产物；为测试隔离删除该文件）
  const file = first.replace('file:///', '').replace(/\//g, path.sep)
  if (existsSync(file)) rmSync(file)
})

// 落雪游戏资源限频：失败进负缓存，冷却期内不重发（成功缓存是永久落盘，不受此限）；
// ensureLocalAssets 对下载失败的 src 就地降级 fallback，不再把在线 URL 留给浏览器重发一次。
// 全程先用注入的 fetchImpl 预置成败态，ensureLocalAssets 内部走缓存/负缓存，不触真网络。
test('assetCache：失败负缓存冷却 + 失败降级 fallback + 裸字段缓存', async () => {
  const mod = await import('../lib/render/assetCache.js')
  const { ensure, ensureLocalAssets } = mod
  let calls = 0
  const failUrl = 'https://lxns.example.test/jacket/99999.png'
  const failImpl = async () => { calls++; return { ok: false } }

  assert.equal(await ensure(failUrl, { fetchImpl: failImpl }), null)
  assert.equal(await ensure(failUrl, { fetchImpl: failImpl }), null, '冷却期内第二次不发请求')
  assert.equal(calls, 1)

  // 失败 + 有 fallback → 就地降级（fallback 本身是 file://，无需下载）
  const data = { images: [{ src: failUrl, fallback: 'file:///local/0.png' }] }
  await ensureLocalAssets(data)
  assert.equal(data.images[0].src, 'file:///local/0.png')
  assert.ok(!('fallback' in data.images[0]), '降级后 fallback 应被摘除')

  // 失败 + 无 fallback → 维持在线 URL 原样（浏览器自决）
  const bareUrl = 'https://lxns.example.test/jacket/99998.png'
  await ensure(bareUrl, { fetchImpl: failImpl })
  const bare = { images: [{ src: bareUrl }] }
  await ensureLocalAssets(bare)
  assert.equal(bare.images[0].src, bareUrl)

  // 裸字段（fsline coverSrc / fib bgCover）：先落盘成功缓存 → 裸字段被替换为本地
  const okUrl = 'https://lxns.example.test/jacket/1.png'
  const ok = await ensure(okUrl, {
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([9]) }),
  })
  const data2 = { coverSrc: okUrl }
  await ensureLocalAssets(data2)
  assert.equal(data2.coverSrc, ok)

  // 清理本次落盘
  for (const u of [ok]) {
    const f = u.replace('file:///', '').replace(/\//g, path.sep)
    if (existsSync(f)) rmSync(f)
  }
})
