/**
 * 静态素材路径单点（设计 §9.1，ADR-8）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 所有素材访问经此处拼接，便于未来切换/在线化。
 */
import fs from 'node:fs'
import path from 'node:path'
import Config from '../config.js'
import { onlineAssetUrl } from '../client/http.js'
import { staticRoot } from '../path.js'

const ONLINE_COVER = 'https://www.yuzuchan.moe/api/maimaidxphoto/cover'

/**
 * 在线素材回退开关（config.assetsOnline，出厂默认开）
 * 关闭后本地缺图不再发起在线请求，由调用方回退默认图/占位（见 collectionSrc / coverSrc）
 * 判据用 `!== false` 而非真值：用户 yaml 早于该键（老配置）时缺失值按「开」处理
 */
export function onlineFallbackOn() {
  return Config.getUserCfg('config', 'assetsOnline') !== false
}

/** 素材绝对路径：lib/render/assets.js 单点拼接 */
export function cover(id) {
  return path.join(staticRoot, 'mai', 'cover', `${id}.png`)
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

/** 在线曲绘 URL（assetsOnline 回退用，源 clients/http.py:58 同语义） */
export function coverOnline(id) {
  return `${ONLINE_COVER}/${id}.png`
}

/**
 * 收藏品切图路径（icon 头像 / plate 姓名框）：资源包内按**各自 id** 命名的 webp
 * （与在线切图同号：在线 `UI_Icon_000302.png` ↔ 本地 `mai/icon/302.webp`，两侧都不补零语义一致）
 */
export function collection(type, id, root = staticRoot) {
  return path.join(root, 'mai', type, `${id}.webp`)
}

/**
 * 模板可用的收藏品切图引用路径（本地资源包优先，缺失才回退在线）
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
  const name = `UI_${type[0].toUpperCase()}${type.slice(1)}_${String(id).padStart(6, '0')}.png`
  return onlineAssetUrl(`/${type}/${name}`)
}

/**
 * 源 `song_chart`（core/image/tools.py:223）：`id % 10000` 的曲绘文件，缺图回退 `0.png`
 * 单点供 render/views.js 的 songChartSrc（页面 img src）与今日舞萌（直发图片 Buffer）共用
 */
export function songChartFile(songId) {
  const p = cover(Number(songId) % 10000)
  return fs.existsSync(p) ? p : cover(0)
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
 * 模板可用的曲绘引用路径（本地优先，在线回退）
 * @returns {string} file:// 绝对 URL / https URL；本地缺失且在线回退关时为 ''
 */
export function coverSrc(id, { allowOnline = onlineFallbackOn() } = {}) {
  const local = cover(id)
  if (fs.existsSync(local)) return `file:///${local.replace(/\\/g, '/')}`
  if (allowOnline) return coverOnline(id)
  return ''
}
