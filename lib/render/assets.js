/**
 * 静态素材路径单点（设计 §9.1，ADR-8）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 所有素材访问经此处拼接，便于未来切换/在线化。
 */
import fs from 'node:fs'
import path from 'node:path'
import Config from '../config.js'
import { lxnsAssetUrl } from '../client/http.js'
import { staticRoot } from '../path.js'

/**
 * 在线素材回退开关（config.assetsOnline，出厂默认开）
 * 关闭后本地缺图不再发起在线请求，由调用方回退默认图/占位（见 collectionSrc / coverSrc）
 * 判据用 `!== false` 而非真值：用户 yaml 早于该键（老配置）时缺失值按「开」处理
 */
export function onlineFallbackOn() {
  return Config.getUserCfg('config', 'assetsOnline') !== false
}

/** 素材绝对路径：lib/render/assets.js 单点拼接 */
export function cover(id, root = staticRoot) {
  return path.join(root, 'mai', 'cover', `${id}.png`)
}

export function pic(...names) {
  return path.join(staticRoot, 'mai', 'pic', ...names)
}

export function font(name) {
  return path.join(staticRoot, 'font', name)
}

export function dataFile(name) {
  return path.join(staticRoot, 'data', name)
}

/**
 * 落雪侧曲目 id：落雪曲库中同一曲目的标准/DX 谱面 id 一致，常规曲不存在 ≥10000 的 id
 * （本地曲库的 DX id ≥10000 须先对 10000 取余）；宴谱例外，id ≥100000 原样。
 * 与落雪别名同款口径（lib/merge/merge.js），资源包本地命名（songChartFile）也一致。
 */
export function lxnsSongId(songId) {
  const id = Number(songId)
  return id >= 100000 ? id : id % 10000
}

/** 落雪曲绘直链（本地资源包缺图回退用；限频资源，务必经 assetCache 落盘后复用） */
export function jacketOnline(songId) {
  return lxnsAssetUrl(`/jacket/${lxnsSongId(songId)}.png`)
}

/**
 * 收藏品切图路径（icon 头像 / plate 姓名框）：资源包内按**各自 id** 命名的 webp
 * （与落雪在线切图同号：落雪 `/icon/302.png` ↔ 本地 `mai/icon/302.webp`，官方 UI id 两侧一致）
 */
export function collection(type, id, root = staticRoot) {
  return path.join(root, 'mai', type, `${id}.webp`)
}

/**
 * 模板可用的收藏品切图引用路径（本地资源包优先，缺失才回退落雪在线）
 *
 * 在线 URL 由 renderer.img → assetCache.ensureLocalAssets 落盘
 * （data/assets/<sha1>.png）后复用，故「首次在线、此后本地」与改前一致；
 * 资源包已带图时则全程零网络等待（P2 半图问题的根治路径）。
 *
 * @param {'icon'|'plate'} type
 * @param {number|string} id 收藏品 id
 * @returns {string} file:// 绝对 URL；本地缺失且在线回退关/无时为 ''（调用方回退默认图）
 */
export function collectionSrc(type, id, { allowOnline = onlineFallbackOn(), root = staticRoot } = {}) {
  const local = collection(type, id, root)
  if (fs.existsSync(local)) return `file:///${local.replace(/\\/g, '/')}`
  if (!allowOnline) return ''
  return lxnsAssetUrl(`/${type}/${id}.png`)
}

/**
 * 源 `song_chart`（core/image/tools.py:223）的本地口径：`id % 10000` 的曲绘文件，缺图回退 `0.png`
 * 供「必须当场读到像素」的同步链路（猜曲绘裁片、今日舞萌直发）用；渲染视图一律走 songChartParts
 */
export function songChartFile(songId, root = staticRoot) {
  return songChartParts(songId, { allowOnline: false, root }).src
}

/**
 * 曲绘三段式：本地资源包 → 落雪在线（限频资源，渲染时由 assetCache 落盘 data/assets 复用）
 * → 默认曲绘 0.png。本地曲库已更新而资源包滞后的窗口期（游戏内临时上新曲），
 * 落雪查分器已有数据，曲绘从在线补齐并缓存，不回写 resources/ 资源包（防更新冲突）。
 * @returns {{ src: string, fallback: string|null }} 绝对路径或在线 URL；fallback 仅在 src 在线时给出
 */
export function songChartParts(songId, { allowOnline = onlineFallbackOn(), root = staticRoot } = {}) {
  const local = cover(Number(songId) % 10000, root)
  if (fs.existsSync(local)) return { src: local, fallback: null }
  if (allowOnline) return { src: jacketOnline(songId), fallback: cover(0, root) }
  return { src: cover(0, root), fallback: null }
}

/**
 * 资源包就绪检测（设计 §9.1）：S/mai/cover 存在且文件数 > 500
 * @param {string} [root] 资源根，默认 resources/static（lib/resourcePack.js 同步后按目标目录复核）
 * @returns {{ ready: boolean, count: number }}
 */
export function checkReadiness(root = staticRoot) {
  const dir = path.join(root, 'mai', 'cover')
  try {
    const count = fs.readdirSync(dir).filter(f => f.endsWith('.png')).length
    return { ready: count > 500, count }
  } catch {
    return { ready: false, count: 0 }
  }
}

/**
 * 裸字段曲绘引用（fib 背景衬图等模板直引场景）：本地优先，在线回退落雪
 * @returns {string} file:// 绝对 URL / https URL；本地缺失且在线回退关时为 ''
 */
export function coverSrc(id, { allowOnline = onlineFallbackOn() } = {}) {
  const local = cover(Number(id) % 10000)
  if (fs.existsSync(local)) return `file:///${local.replace(/\\/g, '/')}`
  if (allowOnline) return jacketOnline(id)
  return ''
}
