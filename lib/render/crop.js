/**
 * 猜曲绘裁片（P3 实施文档 §4.4 / 设计 §8.5）
 *
 * ⚠️ **与源的刻意偏离（已登记）**：源 `core/service/__init__.py:184-226` 用 numpy FFT 的
 * **逐像素频谱幅度**当选窗的空间评分（拿 2D 频谱当 top-left 索引查），语义不匹配、产出接近噪声；
 * 设计 §8.5 本要求改成「灰阶 + 拉普拉斯边缘能量」。
 * 但本仓与宿主都没有像素级图像处理能力（sharp/jimp/canvas/pngjs 在 pnpm store 里，
 * 只链给别的插件；从本插件 import 直接 ERR_MODULE_NOT_FOUND），而 README 承诺
 * 「插件无额外依赖，开箱即用」，故退为**中心偏置随机取窗**。
 * 实施文档 §4.4 本人已声明「裁切位置本来就随机，参照图无从对齐」，此降级可接受。
 *
 * 裁片**不需要**像素运算：模板里用固定尺寸容器 + `overflow:hidden` + 曲绘负偏移，
 * 渲染器截 `#container` 即得裁片（宿主 puppeteer 正是截 `#container` 的 boundingBox）。
 */
import fs from 'node:fs'
import { imageSize } from 'image-size'
import { songChartFile } from './assets.js'
import { renderGuessCrop } from './picmodle.js'

/** 源的裁切尺度范围（`random.uniform(0.15, 0.4)`，注释「裁剪尺寸范围 可在此修改」） */
export const CROP_SCALE_MIN = 0.15
export const CROP_SCALE_MAX = 0.4
/** 窗口中心允许偏离图像中心的幅度（±30% ⇒ 落在中央 60% 区间） */
const CENTER_JITTER = 0.3

/**
 * 取裁切窗口（纯函数，便于单测）
 * @param {number} W 原图宽
 * @param {number} H 原图高
 * @param {() => number} [rand] 注入随机源（默认 Math.random）
 * @returns {{x:number, y:number, w:number, h:number}} 恒落在 `[0, W-w] × [0, H-h]` 内
 */
export function pickCropWindow(W, H, rand = Math.random) {
  const scale = CROP_SCALE_MIN + rand() * (CROP_SCALE_MAX - CROP_SCALE_MIN)
  const w = Math.max(1, Math.trunc(W * scale))
  const h = Math.max(1, Math.trunc(H * scale))
  // 窗口中心落在图像中央 60% 区间：曲绘的边缘多是纯色留白，裁到那儿就看不出是什么了
  const cx = W * (0.5 + (rand() - 0.5) * 2 * CENTER_JITTER)
  const cy = H * (0.5 + (rand() - 0.5) * 2 * CENTER_JITTER)
  const clamp = (v, max) => Math.min(Math.max(Math.trunc(v), 0), Math.max(0, max))
  return { x: clamp(cx - w / 2, W - w), y: clamp(cy - h / 2, H - h), w, h }
}

/**
 * 生成某曲的裁片（一局只生成一次并持有 Buffer）
 * @param {number|string} songId
 * @returns {Promise<Buffer|string>} 裁片 Buffer，或渲染失败文案（字符串）
 */
export async function cropCover(songId) {
  const file = songChartFile(songId)
  const { width, height } = imageSize(fs.readFileSync(file))
  const win = pickCropWindow(width, height)
  return await renderGuessCrop({
    src: `file:///${file.replace(/\\/g, '/').replace(/ /g, '%20')}`,
    W: width,
    H: height,
    ...win,
  })
}
