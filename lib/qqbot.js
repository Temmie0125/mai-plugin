/**
 * 官方 QQBot 适配层（QQBot-Plugin 适配器，adapter 名 "QQBot"）
 *
 * 官方 Bot 与 OneBot 的通道差异（适配点见 config.yaml「官方QQBot适配」组）：
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
 *    （刻意不设 send/enter 自动发送——多数命令还需补参数，直接发出只会换来格式错误），
 *    图鉴/成绩卡等场景还会把当前歌曲 id 一并预填进查成绩/分数线。
 * 4. 提示附言：按钮**确实会随消息发出**时，撤掉 handler 层附在图后的文字提示
 *    （MESSAGE()，如「可使用「#mai theme」指令更换主题…」）——按钮本身已承载同样的引导，
 *    文字+按钮并存是重复信息；按钮发不出去（配置关/非 QQBot/宿主无 segment.button）时照旧携带。
 *
 * 适配点集中在 `MaiPlugin.reply`（apps 下所有命令类的基类）。
 */
import plugin from '../../../lib/plugins/plugin.js'
import Config from './config.js'

const logger = global.logger || console

/**
 * handler 层的图后提示文本（MESSAGE()，适配点 4 的识别目标）。
 * ⚠️ 刻意**惰性动态引入** handler.js：它会拉起 service 等重依赖，而本模块被 apps 静态引入——
 * 若静态引入，service 会提前进所有 app（以及 tests/rules.test.js 那类先静态 import app、
 * 后给 global.logger 打桩的测试）的模块图，service 顶层捕获到的 logger 就不是宿主/stub 的
 * 带mark实现，mai.init 会挂。apps 自身本就加载了 handler.js，运行时取是缓存命中、零开销。
 */
let _MESSAGE = null
async function messageHint() {
  if (_MESSAGE == null) _MESSAGE = await import('./handler.js').then(m => m.MESSAGE())
  return _MESSAGE
}

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
 * 快捷按钮预设：行→按钮 的二维数组，input 里的 {h} 生成时替换为当前命令头、
 * {id} 替换为场景传入的歌曲 id（无 id 时留空，等价于只预填命令）。
 * 按钮对象只设 text/input：不设 send ⇒ 点击仅把命令填进输入框（官方端不自动发送），
 * 便于先补参数（如「#mai fsline <id>」后接难度色与达成率）再发出；也不设
 * callback/reply（自动发送/引用均非本特性所需，引用还会踩适配点 2 的鸿蒙问题）。
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
  /** 谱面/成绩卡：{id} 预填当前歌曲，查成绩/分数线可直接发出或续填难度等参数 */
  chart: [
    [
      { text: '查成绩', input: '#{h} score {id}' },
      { text: '分数线', input: '#{h} fsline {id}' },
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
 * @param {string|{name: string, songId?: number|string}} scene 预设键，或带歌曲 id 的对象
 *   （{id} 只在 songId 为纯数字时替换，否则留空）
 */
export function buttonSegment(scene = 'image') {
  const name = typeof scene === 'string' ? scene : scene?.name
  const rows = BUTTON_PRESETS[name]
  const segment = globalThis.segment
  if (!rows || typeof segment?.button !== 'function') return null
  const h = cmdHead()
  const id = /^\d+$/.test(String(scene?.songId ?? '')) ? String(scene.songId) : ''
  return segment.button(
    ...rows.map(row => row.map(b => ({
      ...b,
      input: b.input.replaceAll('{h}', h).replaceAll('{id}', id),
    }))),
  )
}

/**
 * 撤掉 handler 层附在图后的提示附言（适配点 4）：按钮**确实会发出**时按钮本身已承载
 * 同样引导（「可使用「#mai theme」指令更换主题…」），文字+按钮并存是重复信息。
 * 只按提示文本精确匹配（容忍前导换行，猜歌揭晓卡等走同样载荷的路径也在覆盖内），
 * 全服统计文本等其他附言不受影响；撤完若载荷被清空则保持原样（防御）。
 * 纯函数：hint 由调用方传入（MaiPlugin.reply 经 messageHint() 惰性取 MESSAGE()）。
 * @param {object|Array} msg 回复载荷
 * @param {string} hint 要撤的提示文本（handler.js MESSAGE() 的当前值）
 */
export function stripBizHint(msg, hint) {
  if (!Array.isArray(msg) || !hint) return msg
  const isHint = v => {
    const t = typeof v === 'string' ? v : v?.type === 'text' ? v.text : null
    return t != null && t.replace(/^\n+/, '') === hint
  }
  const out = msg.filter(v => !isHint(v))
  return out.length ? out : msg
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
        // 适配点 3：快捷按钮（data.qqBtn 指定场景预设；无提示且载荷含图时用业务图兜底组）
        let btn = null
        if (Config.getUserCfg('config', 'qqBotButtons') !== false) {
          const scene = data?.qqBtn || (hasImage(msg) ? 'image' : null)
          btn = scene ? buttonSegment(scene) : null
          // 适配点 4：按钮确实会发出 → 文字提示附言是重复信息，撤掉（先撤再做图文换行）
          if (btn) msg = stripBizHint(msg, await messageHint())
        }
        // 适配点 1：图文相邻补换行
        msg = breakAroundImages(msg)
        if (btn) msg = [...(Array.isArray(msg) ? msg : [msg]), btn]
      }
    } catch (err) {
      // 适配是锦上添花，失败绝不挡回复：按原载荷原参数发送
      logger.warn(`[mai-plugin] QQBot 适配处理失败，按原载荷发送：${err?.message || err}`)
    }
    return super.reply(msg, quote, data)
  }
}
