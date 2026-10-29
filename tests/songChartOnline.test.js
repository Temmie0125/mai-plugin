/**
 * 曲绘三段式（本地资源包 → 落雪在线 → 默认曲绘 0.png）与落雪侧曲目 id 口径
 *
 * 场景：游戏内临时上新曲、资源包尚未跟进，而落雪查分器已有数据 —— 本地缺图时按
 * 落雪游戏资源（assets2.lxns.net/maimai/jacket/{id}.png）在线补齐，渲染时经
 * assetCache 落盘 data/assets 复用；绝不回写 resources/ 资源包（防更新冲突）。
 *
 * 本文件只锁 URL/路径决策（不触网、不起浏览器、不写资源包）：
 *   ① 落雪侧 id：DX id ≥10000 取余、SD 原样、宴谱 ≥100000 例外原样；
 *   ② 三段式回退次序与 0.png 兜底（root 可注入，不动真资源包）；
 *   ③ 视图接线：songChartImg 元素在在线分支确实挂 fallback。
 */
import { test, after } from 'node:test'
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

const { lxnsSongId, songChartParts, songChartFile } = await import('../lib/render/assets.js')
const { songChartImg } = await import('../lib/render/views.js')

/** 假资源根：只放 cover/5.png 与 cover/0.png 两张，其余一律视为缺图（不动真资源包） */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-jacket-'))
fs.mkdirSync(path.join(root, 'mai', 'cover'), { recursive: true })
fs.writeFileSync(path.join(root, 'mai', 'cover', '5.png'), 'PNG-stub')
fs.writeFileSync(path.join(root, 'mai', 'cover', '0.png'), 'PNG-stub')
after(() => fs.rmSync(root, { recursive: true, force: true }))

const fileUrlOf = p => `file:///${p.replace(/\\/g, '/')}`
const JACKET = id => `https://assets2.lxns.net/maimai/jacket/${id}.png`

// =====================================================================
// ① 落雪侧曲目 id（同落雪别名坑：常规曲无 ≥10000 的 id）
// =====================================================================

test('lxnsSongId：DX id ≥10000 对 10000 取余、SD 原样、宴谱 ≥100000 例外原样', () => {
  assert.equal(lxnsSongId(11001), 1001, '本地曲库 DX id 须取余后才可请求落雪')
  assert.equal(lxnsSongId(1189), 1189, 'SD id 原样')
  assert.equal(lxnsSongId('2025'), 2025, '字符串 id 同样处理')
  assert.equal(lxnsSongId(100001), 100001, '宴谱例外，原样请求')
  assert.equal(lxnsSongId(1110001), 1110001, '≥100000 一律视为宴谱，不取余')
})

// =====================================================================
// ② 三段式：本地 → 落雪在线 → 0.png
// =====================================================================

test('songChartParts：本地命中 → 本地绝对路径，无 fallback（零网络）', () => {
  const { src, fallback } = songChartParts(10005, { root }) // 10005 % 10000 = 5 → 假根有图
  assert.equal(src, path.join(root, 'mai', 'cover', '5.png'))
  assert.equal(fallback, null)
})

test('songChartParts：本地缺失 → 落雪曲绘 URL（DX 取余后）+ 0.png 兜底', () => {
  const { src, fallback } = songChartParts(11202, { root }) // % 10000 = 1202 → 缺图
  assert.equal(src, JACKET(1202))
  assert.equal(fallback, path.join(root, 'mai', 'cover', '0.png'))
})

test('songChartParts：宴谱 id 直连落雪（不取余）', () => {
  const { src, fallback } = songChartParts(100001, { root })
  assert.equal(src, JACKET(100001))
  assert.equal(fallback, path.join(root, 'mai', 'cover', '0.png'))
})

test('songChartParts：在线回退关闭 → 直接 0.png，无 fallback', () => {
  const { src, fallback } = songChartParts(11202, { root, allowOnline: false })
  assert.equal(src, path.join(root, 'mai', 'cover', '0.png'))
  assert.equal(fallback, null)
})

test('songChartFile：同步链路（裁片/今日舞萌直发）口径不变：本地优先、缺图 0.png', () => {
  assert.equal(songChartFile(10005, root), path.join(root, 'mai', 'cover', '5.png'))
  assert.equal(songChartFile(11202, root), path.join(root, 'mai', 'cover', '0.png'))
})

// =====================================================================
// ③ 视图接线：songChartImg 元素
// =====================================================================

test('songChartImg：在线分支挂 0.png fallback；本地/关在线分支无 fallback', () => {
  const online = songChartImg(11202, 0, 0, 75, 75, {}, { root })
  assert.equal(online.src, JACKET(1202))
  assert.equal(online.fallback, fileUrlOf(path.join(root, 'mai', 'cover', '0.png')))

  const local = songChartImg(10005, 0, 0, 75, 75, {}, { root })
  assert.equal(local.src, fileUrlOf(path.join(root, 'mai', 'cover', '5.png')))
  assert.ok(!('fallback' in local), '本地命中不应带 fallback')

  const off = songChartImg(11202, 0, 0, 75, 75, {}, { root, allowOnline: false })
  assert.equal(off.src, fileUrlOf(path.join(root, 'mai', 'cover', '0.png')))
  assert.ok(!('fallback' in off), '默认曲绘自身无需兜底')
})
