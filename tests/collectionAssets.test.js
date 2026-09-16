/**
 * 收藏品切图（icon 头像 / plate 姓名框）本地优先链路
 *
 * 背景：资源包补齐了 `mai/icon/<id>.webp` 与 `mai/plate/<id>.webp`（按收藏品 id 命名，
 * webp，不补零），落雪数据源渲染的 B50 头部两处切图要从「在线 + 缓存」改为
 * 「本地命中即 file://，缺失才在线取并缓存」；顺带把此前**声明但从未被读取**的
 * `config.assetsOnline`（在线素材回退）接上。
 *
 * 本文件锁三件事（不触网、不起浏览器、不写资源包）：
 *   ① 路径与在线切图同号（`mai/icon/302.webp` ↔ `UI_Icon_000302.png`）；
 *   ② 回退次序：本地 → 在线 → 空串（调用方回退默认图）；
 *   ③ 视图接线：b50View 头部两处切图确实走该次序。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Config from '../lib/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const { collection, collectionSrc, onlineFallbackOn } =
  await import('../lib/render/assets.js')
const { b50View, picSrc } = await import('../lib/render/views.js')

const DEFAULT_ICON = picSrc('UI_Icon_509506.png')
const DEFAULT_PLATE = picSrc('UI_Plate_550101.png')

/** 在线切图 URL 形态（源 _fetch_image：UI_Icon_000302.png / UI_Plate_000123.png，6 位补零） */
const onlineIcon = id => `https://www.yuzuchan.moe/assets/maimaidx/icon/UI_Icon_${String(id).padStart(6, '0')}.png`
const onlinePlate = id => `https://www.yuzuchan.moe/assets/maimaidx/plate/UI_Plate_${String(id).padStart(6, '0')}.png`

/** 假资源根：只放 icon/302.webp 一张，用于「本地命中」分支（不动真资源包） */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-cutout-'))
fs.mkdirSync(path.join(root, 'mai', 'icon'), { recursive: true })
fs.writeFileSync(path.join(root, 'mai', 'icon', '302.webp'), 'RIFF-stub')
after(() => fs.rmSync(root, { recursive: true, force: true }))

const fileUrlOf = p => `file:///${p.replace(/\\/g, '/')}`

/** 改内存里的用户配置副本（不落盘），跑完还原 */
function withAssetsOnline(value, fn) {
  const userCfg = Config.getConfig('config')
  const saved = userCfg.assetsOnline
  const had = 'assetsOnline' in userCfg
  if (value === undefined) delete userCfg.assetsOnline
  else userCfg.assetsOnline = value
  try {
    return fn()
  } finally {
    if (had) userCfg.assetsOnline = saved
    else delete userCfg.assetsOnline
  }
}

// =====================================================================
// ① 路径 / URL 形态
// =====================================================================

test('collection：按收藏品 id 命名（不补零），type 决定子目录', () => {
  assert.equal(collection('icon', 302, root), path.join(root, 'mai', 'icon', '302.webp'))
  assert.equal(collection('plate', 100001, root), path.join(root, 'mai', 'plate', '100001.webp'))
})

test('collectionSrc：本地缺失 → 在线切图 URL（源 _fetch_image 的 UI_Type_000000.png 形态）', () => {
  // 假资源根里只有 icon/302.webp，其余一律视为缺图
  assert.equal(collectionSrc('plate', 123, { root }), onlinePlate(123))
  assert.equal(collectionSrc('icon', 303, { root }), onlineIcon(303))
})

// =====================================================================
// ② 回退次序
// =====================================================================

test('collectionSrc：本地命中 → file://（在线开关无关，且不再触网）', () => {
  const src = collectionSrc('icon', 302, { root })
  assert.equal(src, fileUrlOf(path.join(root, 'mai', 'icon', '302.webp')))
  assert.equal(collectionSrc('icon', 302, { root, allowOnline: false }), src, '本地命中不受在线开关影响')
})

test('collectionSrc：在线回退关闭 → 本地缺失返回空串（调用方回退默认图）', () => {
  assert.equal(collectionSrc('plate', 123, { root, allowOnline: false }), '')
})

// =====================================================================
// ③ config.assetsOnline 接线
// =====================================================================

test('onlineFallbackOn：读 config.assetsOnline；缺键（老配置）按开处理', () => {
  withAssetsOnline(false, () => {
    assert.equal(onlineFallbackOn(), false)
    // 默认参数走配置 → 本地缺失且开关关闭时为空串
    assert.equal(collectionSrc('plate', 123, { root }), '')
  })
  withAssetsOnline(true, () => {
    assert.equal(onlineFallbackOn(), true)
    assert.equal(collectionSrc('plate', 123, { root }), onlinePlate(123))
  })
  withAssetsOnline(undefined, () => assert.equal(onlineFallbackOn(), true, '缺键应按开处理'))
})

// =====================================================================
// ④ 视图接线（b50View 头部）：plate(300,60) / icon(305,65)
// =====================================================================

const PLAYER = { name: 'テスト', rating: 15234, course_rank: 5, class_rank: 3, trophy: null }
const BEST50 = { sd: [], dx: [], sd_total: 0, dx_total: 0 }
/**
 * 视图层走的是**真资源根**（staticRoot 不可注入），故「缺图」分支必须用包内绝无可能存在的 id
 * （收藏品 id 为 6 位，7 位数字必无），否则本机装了资源包就会命中本地、把断言带偏。
 */
const ABSENT_ICON = 9999999
const ABSENT_PLATE = 9999998
const header = view => ({
  plate: view.images.find(im => im.x === 300 && im.y === 60),
  icon: view.images.find(im => im.x === 305 && im.y === 65),
})
const viewOf = (player, qqid = null) =>
  b50View({ player: { ...PLAYER, ...player }, best50: BEST50, qqid, serviceName: 'Lxns-Network', botName: 'MaiTest' })

test('b50View：收藏品缺图 → 在线切图 URL（并保留默认图作 onerror 兜底）', () => {
  const { plate, icon } = header(viewOf({ icon: { id: ABSENT_ICON }, name_plate: { id: ABSENT_PLATE } }))
  assert.equal(icon.src, onlineIcon(ABSENT_ICON))
  assert.equal(icon.fallback, DEFAULT_ICON)
  assert.equal(plate.src, onlinePlate(ABSENT_PLATE))
  assert.equal(plate.fallback, DEFAULT_PLATE)
})

test('b50View：assetsOnline 关闭且缺图 → 直接上默认图（不留在线 src）', () => {
  withAssetsOnline(false, () => {
    const { plate, icon } = header(viewOf({ icon: { id: ABSENT_ICON }, name_plate: { id: ABSENT_PLATE } }))
    assert.equal(icon.src, DEFAULT_ICON)
    assert.equal(plate.src, DEFAULT_PLATE)
  })
})

test('b50View：无收藏品时仍是 QQ 头像 / 默认牌（不回归）', () => {
  const { plate, icon } = header(viewOf({ icon: null, name_plate: null }))
  assert.equal(plate.src, DEFAULT_PLATE)
  assert.equal(icon.src, DEFAULT_ICON)

  // 有 qqid 且无收藏品 → QQ 头像（该链路不属「切图回退」，不受 assetsOnline 约束）
  const withQq = header(viewOf({ icon: null, name_plate: null }, 10001))
  assert.equal(withQq.icon.src, 'https://q1.qlogo.cn/g?b=qq&nk=10001&s=100')
  withAssetsOnline(false, () => {
    assert.equal(header(viewOf({ icon: null, name_plate: null }, 10001)).icon.src,
      'https://q1.qlogo.cn/g?b=qq&nk=10001&s=100', 'QQ 头像链路不受 assetsOnline 影响')
  })
})

test('b50View：资源包有图 → 头部切图走本地 file://（包缺失则跳过）', t => {
  const iconDir = path.join(__dirname, '..', 'resources', 'static', 'mai', 'icon')
  let packed = null
  try {
    packed = fs.readdirSync(iconDir).find(f => f.endsWith('.webp'))
  } catch { /* 资源包未装 */ }
  if (!packed) return t.skip('resources/static/mai/icon 无 webp（资源包未装）')

  const id = Number(path.basename(packed, '.webp'))
  const { icon } = header(viewOf({ icon: { id }, name_plate: null }))
  assert.equal(icon.src, fileUrlOf(path.join(iconDir, `${id}.webp`)))
})
