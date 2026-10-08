/**
 * 官方 QQBot 适配层（QQBot-Plugin 适配器，adapter 名 "QQBot"）
 *
 * 官方 Bot 与 OneBot 的通道差异（三个适配点，均见 config.yaml「官方QQBot适配」组）：
 * 1. 图文混排：适配器 raw markdown 模式把 image 段转成 `![图片 #Wpx #Hpx](url)` 后
 *    **直接拼接**后续文本（adapter/build.js makeRawMarkdownMsg，无换行），官方端把
 *    markdown 内联图渲染成嵌入式小图、与文字同排；OneBot 的 image 元素独占一行，无此问题。
 *    ⇒ 仅 QQBot 环境在图文相邻处补 `\n`（raw markdown 按原文发送，`\n` 即换行；
 *    legacy 模式适配器会把 `\n` 转 `\r`，同样成立）。
 * 2. 引用回复：带图回复引用用户消息（segment.reply）时，部分设备（鸿蒙端）无法显示图片
 *    ⇒ `quoteReply: false` 时丢弃引用参数（官方 Bot 的被动性由适配器经 event_id 承担，
 *    不依赖引用段，关掉不影响发送）。
 * 3. 快捷按钮：官方 Bot 支持 button 消息段（OneBot 无法发送，适配器直接丢弃该段）
 *    ⇒ `qqBotButtons: true` 时业务图回复附带常用命令按钮；点击仅**预填输入框**
 *    （刻意不设 send/enter 自动发送——多数命令还需补参数，直接发出只会换来格式错误）。
 *
 * 三个适配点集中在 `MaiPlugin.reply`（apps 下所有命令类的基类）。
 */
import plugin from '../../../lib/plugins/plugin.js'
import Config from './config.js'

const logger = global.logger || console

/** 当前命令头（yaml 原值、不做正则转义——按钮 input 里要的是用户输入的字面） */
export const cmdHead = () => Config.getUserCfg('config', 'cmdhead') || 'mai'

/**
 * 官方 QQBot 环境判定。
 * 主判据：TRSS-Yunzai prepareEvent 把 bot.adapter.id/name 摊平到 e 上
 *（QQBot-Plugin 两者均为 "QQBot"，且无其他适配器重名）；
 * 兜底：该适配器把 e.platform 设为 "QQ-group"/"QQ-private"（OneBot 系不设 platform）。
 * @param {object} e Yunzai 事件对象
 */
export function isQQBot(e) {
  if (!e) return false
  if (e.adapter_name === 'QQBot' || e.bot?.adapter?.name === 'QQBot') return true
  return typeof e.platform === 'string' && e.platform.startsWith('QQ')
}

const isImageSeg = i => !!i && (i.type === 'image' || Buffer.isBuffer(i))

/**
 * 载荷是否含图片（segment.image 或裸 Buffer）
 * @param {object|Array} msg 回复载荷
 */
export function hasImage(msg) {
  return (Array.isArray(msg) ? msg : [msg]).some(isImageSeg)
}

/**
 * 图文相邻处补换行（**仅 QQBot 环境调用**；OneBot 下 image 元素独占一行，补了反而多空行）。
 * 覆盖三种相邻：图→文本（文本加 \n 前缀）、文本→图（文本加 \n 后缀）、图→图
 * （markdown 里连排图片会挤同一行，中间插一个换行段）。
 * 幂等：文本已以 \n 为对应边界时不再加。返回新数组，不改调用方原数组
 *（宿主 loader 还会在其上 unshift reply/at 段）。
 * @param {object|Array} msg 回复载荷
 */
export function breakAroundImages(msg) {
  if (!Array.isArray(msg)) return msg
  const out = [...msg]
  /** side='before' 给图后的文本加 \n 前缀；'after' 给图前的文本加 \n 后缀 */
  const addBreak = (idx, side) => {
    const v = out[idx]
    if (typeof v === 'string') {
      if (!v || (side === 'before' ? v.startsWith('\n') : v.endsWith('\n'))) return
      out[idx] = side === 'before' ? `\n${v}` : `${v}\n`
    } else if (v?.type === 'text' && v.text) {
      if (side === 'before' ? v.text.startsWith('\n') : v.text.endsWith('\n')) return
      out[idx] = { ...v, text: side === 'before' ? `\n${v.text}` : `${v.text}\n` }
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (!isImageSeg(out[i])) continue
    if (isImageSeg(out[i + 1])) {
      // 图→图：插换行段后 continue，第二张图下一轮自会处理它的相邻
      out.splice(i + 1, 0, { type: 'text', text: '\n' })
      continue
    }
    addBreak(i + 1, 'before')
    addBreak(i - 1, 'after')
  }
  return out
}

/**
 * 快捷按钮预设：行→按钮 的二维数组，input 里的 {h} 生成时替换为当前命令头。
 * 按钮对象只设 text/input：不设 send ⇒ 点击仅把命令填进输入框（官方端不自动发送），
 * 便于先补参数（如「#mai score 」后接曲名）再发出；也不设 callback/reply（自动发送/
 * 引用均非本特性所需，引用还会踩适配点 2 的鸿蒙问题）。
 */
const BUTTON_PRESETS = {
  /** 业务图兜底（无场景提示时的默认组） */
  image: [
    [
      { text: '更换主题', input: '#{h} theme' },
      { text: '更换查分器', input: '#{h} source' },
      { text: '帮助', input: '#{h} 帮助' },
    ],
  ],
  /** B50 家族（b50/ap50/拟合b50/随心配/歌50） */
  b50: [
    [
      { text: '拟合b50', input: '#{h} 拟合b50' },
      { text: 'AP50', input: '#{h} ap50' },
      { text: '更新缓存', input: '#{h} update' },
    ],
    [
      { text: '更换主题', input: '#{h} theme' },
      { text: '更换查分器', input: '#{h} source' },
    ],
  ],
  /** 谱面/成绩卡：查成绩与分数线都要补曲名，故刻意只预填 */
  chart: [
    [
      { text: '查成绩', input: '#{h} score ' },
      { text: '分数线', input: '#{h} fsline ' },
    ],
  ],
  /** 帮助图 */
  help: [
    [
      { text: '随心配帮助', input: '#{h} 随心配 帮助' },
      { text: 'b50', input: '#{h} b50' },
    ],
  ],
}

/**
 * 生成按钮段（segment.button）；宿主无 segment.button 或预设不存在时返回 null
 * @param {keyof typeof BUTTON_PRESETS} name 预设键
 */
export function buttonSegment(name = 'image') {
  const rows = BUTTON_PRESETS[name]
  const segment = globalThis.segment
  if (!rows || typeof segment?.button !== 'function') return null
  const h = cmdHead()
  return segment.button(...rows.map(row => row.map(b => ({ ...b, input: b.input.replaceAll('{h}', h) }))))
}

/**
 * mai-plugin 命令类基类（apps 下所有 plugin 类继承），唯一的回复出口：
 * 在宿主 plugin.reply 之前插入官方 Bot 适配（引用开关 / 图文换行 / 快捷按钮）。
 * OneBot 环境下除 quoteReply 开关外零改动。
 */
export class MaiPlugin extends plugin {
  async reply(msg = '', quote = false, data = {}) {
    try {
      // 适配点 2：全局引用开关（其余场景语义不变，仅丢弃引用段）
      if (quote && Config.getUserCfg('config', 'quoteReply') === false) quote = false

      if (isQQBot(this.e)) {
        // 适配点 1：图文相邻补换行
        msg = breakAroundImages(msg)
        // 适配点 3：快捷按钮（data.qqBtn 指定场景预设；无提示且载荷含图时用业务图兜底组）
        if (Config.getUserCfg('config', 'qqBotButtons') !== false) {
          const scene = data?.qqBtn || (hasImage(msg) ? 'image' : null)
          const btn = scene && buttonSegment(scene)
          if (btn) msg = [...(Array.isArray(msg) ? msg : [msg]), btn]
        }
      }
    } catch (err) {
      // 适配是锦上添花，失败绝不挡回复：按原载荷原参数发送
      logger.warn(`[mai-plugin] QQBot 适配处理失败，按原载荷发送：${err?.message || err}`)
    }
    return super.reply(msg, quote, data)
  }
}
