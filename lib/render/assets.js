/**
 * 静态素材路径单点（设计 §9.1，ADR-8）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 所有素材访问经此处拼接，便于未来切换/在线化。
 */
import fs from 'node:fs'
import path from 'node:path'
import { staticRoot } from '../path.js'

const ONLINE_COVER = 'https://www.yuzuchan.moe/api/maimaidxphoto/cover'

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
 * @returns {string} file:// 绝对 URL 或 https URL
 */
export function coverSrc(id, { allowOnline = true } = {}) {
  const local = cover(id)
  if (fs.existsSync(local)) return `file:///${local.replace(/\\/g, '/')}`
  if (allowOnline) return coverOnline(id)
  return ''
}
