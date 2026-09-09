/**
 * 宿主渲染器薄封装（设计 §8.1，ADR-5/9）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 *
 * - 复用宿主全局 Renderer 单例（renderers/puppeteer），不自建 Chromium
 * - img() 失败/超时返回可发送的中文文案字符串而非抛异常（phi-plugin 教训）
 * - 模板数据统一注入 _resPath（插件 resources 绝对路径），模板内以
 *   <img src="{{_resPath}}static/..."> 绝对路径引用本地素材（设计 §8.2）
 */
import fs from 'node:fs'
import Config from '../config.js'
import { pluginRoot, staticRoot, htmlRoot } from '../path.js'

const RENDER_ERROR = '渲染器不可用，请检查宿主 puppeteer 渲染后端是否正常'

async function getRenderer() {
  // 惰性导入宿主渲染器 loader：其构造依赖 cwd（renderers/ 相对目录），单测场景延迟到真正渲染时
  const loader = (await import('../../../../lib/renderer/loader.js')).default
  const r = loader.getRenderer()
  if (!r || typeof r.screenshot !== 'function') return null
  return r
}

/**
 * 渲染一张图
 * @param {string} name 图片名（temp/html/<name>/ 落盘目录名）
 * @param {object} opts
 * @param {string} opts.tpl 模板相对 resources/html 的路径，如 'help.html'
 * @param {object} opts.data art-template 模板数据（自动附加 _resPath）
 * @param {'jpeg'|'png'} [opts.imgType] 默认 jpeg
 * @param {number} [opts.quality] 默认取配置 renderQuality
 * @param {boolean} [opts.multiPage] 超高页分片，返回 Buffer[]
 * @param {string} [opts.saveId] 落盘 html 文件名，默认取 name
 * @returns {Promise<Buffer|Buffer[]|string>} Buffer 或错误文案字符串
 */
export async function img(name, { tpl, data = {}, imgType = 'jpeg', quality, multiPage = false, saveId }) {
  const renderer = await getRenderer()
  if (!renderer) {
    logger?.error?.('[mai-plugin] 未获取到宿主渲染器实例')
    return RENDER_ERROR
  }
  const tplFile = `${htmlRoot}/${tpl}`
  if (!fs.existsSync(tplFile)) {
    logger?.error?.(`[mai-plugin] 模板不存在：${tplFile}`)
    return `模板缺失：${tpl}`
  }
  try {
    // 宿主 dealTpl 将整个 data 对象交给 art-template，模板变量必须平铺在顶层
    const buffer = await renderer.screenshot(`mai-plugin/${name}`, {
      tplFile,
      saveId: saveId || name,
      imgType,
      quality: quality ?? (Number(Config.getUserCfg('config', 'renderQuality')) || 92),
      multiPage,
      ...data,
      /**
       * 插件 resources 目录绝对路径：模板中 {{_resPath}}static/... 引用本地素材。
       * 必须转 file:/// + 正斜杠（Windows 反斜杠裸路径不是合法 URL，字体/图片静默加载失败，
       * phi-plugin picmodle.js:383 同款 replace(/\\/g, '/') 处理）
       */
      _resPath: `file:///${pluginRoot.replace(/\\/g, '/')}/resources`,
      _staticPath: `file:///${staticRoot.replace(/\\/g, '/')}`,
    })
    if (!buffer) {
      logger?.error?.(`[mai-plugin] 渲染失败：${name}（渲染器返回空）`)
      return '图片生成失败，请稍后再试'
    }
    // 宿主渲染器不同链路可能返回裸 Buffer，也可能返回已包装的成图对象——
    // 原样上交，由 picmodle.toSegment 统一判断（已是成图绝不再套一层 segment）
    return buffer
  } catch (error) {
    logger?.error?.(`[mai-plugin] 渲染异常：${name}`, error)
    return '图片生成失败，请稍后再试'
  }
}
