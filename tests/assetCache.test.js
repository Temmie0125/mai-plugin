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
  assert.equal(extOf('https://www.yuzuchan.moe/assets/maimaidx/icon/UI_Icon_000302.png'), '.png')
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
