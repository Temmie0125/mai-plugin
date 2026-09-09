/**
 * 业务图统一入口（设计 §8.1/§8.3）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 所有命令的图片发送出口：返回 segment.image(Buffer) 或错误文案字符串，调用方直接 e.reply。
 * （源 text_to_bytes_io 长文本转图已废除——长列表走 makeForwardMsg 合并转发，§6.4/§8.6）
 */
import { img } from './renderer.js'
import { coverSrc } from './assets.js'
import helpInfo from '../../resources/info/help.json' with { type: 'json' }

/**
 * 渲染结果 → 可发送消息（统一出口）
 * - 裸 Buffer → 包一层 segment.image
 * - Buffer[]（multiPage 分片）→ 逐片包装
 * - 已是成图对象（部分渲染链路返回 segment）或错误文案字符串 → 原样发送，绝不再套一层
 */
export function toSegment(result) {
  const segment = globalThis.segment
  if (Buffer.isBuffer(result)) return segment?.image ? segment.image(result) : result
  if (Array.isArray(result)) {
    return result.map(item => (Buffer.isBuffer(item) && segment?.image ? segment.image(item) : item))
  }
  return result
}

/**
 * 帮助图数据构建：help.json 中 {head} 占位符替换为当前 cmdhead（设计 §3.1）
 * @param {string} cmdHead 未转义的命令头词
 */
export function buildHelpData(cmdHead, pluginVersion = '') {
  const groups = helpInfo.map(group => ({
    ...group,
    auth: group.auth || '',
    list: group.list.map(item => ({
      ...item,
      title: item.title.replaceAll('{head}', cmdHead),
      eg: item.eg.replaceAll('{head}', cmdHead),
    })),
  }))
  /**
   * 紧凑三列分配（按各组成员数均衡，组不可拆）：
   * 列1 查询成绩(9)+娱乐互动(6)=15 · 列2 表格成绩(7)+别名(7)+管理(2)=16
   * 列3 绑定与设置(4)+口语指令(6)=10，右侧剩余高度由参数说明卡+版权卡补齐（版权贴底）
   * groups 顺序调整时需同步调整下标分组
   */
  const columns = [
    [groups[0], groups[3]],
    [groups[1], groups[4], groups[5]],
    [groups[2], groups[6]],
  ]
  return {
    groups,
    columns,
    cmdHead,
    version: pluginVersion,
    /** 随机背景曲绘（file:// 本地优先，缺失在线回退，§8.2） */
    bgCover: coverSrc(1189),
    copyright: '视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot',
  }
}

/**
 * 渲染帮助图
 * @returns {Promise<Buffer|string>} 图片 Buffer 或错误文案
 */
export async function renderHelp(cmdHead, pluginVersion = '') {
  return img('help', {
    tpl: 'help.html',
    data: buildHelpData(cmdHead, pluginVersion),
    imgType: 'jpeg',
  })
}
