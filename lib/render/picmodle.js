/**
 * 业务图统一入口（设计 §8.1/§8.3）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 所有命令的图片发送出口：返回 segment.image(Buffer) 或错误文案字符串，调用方直接 e.reply。
 * （源 text_to_bytes_io 长文本转图已废除——长列表走 makeForwardMsg 合并转发，§6.4/§8.6）
 */
import fs from 'node:fs'
import path from 'node:path'
import { img } from './renderer.js'
import { coverSrc } from './assets.js'
import { staticRoot } from '../path.js'
import Config from '../config.js'
import helpInfo from '../../resources/info/help.json' with { type: 'json' }

/** BOT 展示名（源 bot_name：配置项 → 宿主昵称 → Maimai） */
export function botName() {
  return Config.getUserCfg('config', 'botName')
    || globalThis.Bot?.name
    || 'Maimai'
}

/** echarts.min.js 全文缓存（饼图模板内联注入，规避 file:// script 加载限制，设计 §8.4） */
let _echartsJs = null
function echartsJsSource() {
  if (_echartsJs == null) {
    _echartsJs = fs.readFileSync(path.join(staticRoot, 'echarts.min.js'), 'utf8')
  }
  return _echartsJs
}

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

// ===== P1 查询页面（视图由 lib/render/views.js 坐标直译构建）=====

/** B50 / AP50 长图（1400×1600 固定背景页） */
export async function renderBest50(view) {
  return img('b50', { tpl: 'b50.html', data: view, imgType: 'jpeg' })
}

/** 单曲成绩卡（1200×900 play_info） */
export async function renderPlayData(view) {
  return img('score', { tpl: 'score.html', data: view, imgType: 'jpeg' })
}

/** 谱面信息卡（1200×1300 chart_info / 宴会场 1200×1200） */
export async function renderChartInfo(view) {
  return img('song', { tpl: 'song.html', data: view, imgType: 'jpeg' })
}

/** 曲目列表（1000×自适应渐变页） */
export async function renderSongList(view) {
  return img('songlist', { tpl: 'songlist.html', data: view, imgType: 'jpeg' })
}

/** 全服统计饼图（ECharts 内联注入） */
export async function renderGlobalData(view) {
  return img('global', {
    tpl: 'global.html',
    data: {
      width: view.width,
      height: view.height,
      echartsJs: echartsJsSource(),
      titleJson: JSON.stringify(view.title),
      fcDataJson: JSON.stringify(view.fcData),
      accDataJson: JSON.stringify(view.accData),
    },
    imgType: 'jpeg',
  })
}
