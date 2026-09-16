/**
 * #mai com|calc|计算 <定数> <达成率> —— 单曲 Rating 计算器
 * 收编自外挂脚本 Yunzai/plugins/example/maicom.js（maiRating）：
 * 原版自读 data/mairat.txt 评级系数表（外部资源），本版复用 lib/calc.js 的
 * computeRating / getBaseRa（同一套官方系数常量 BASE_RA_SPP），零外部文件依赖。
 * 纯计算不碰曲库/用户数据，故无 ensureReady 与绑定门槛，资源未下载也可用。
 *
 * 与原版输出的差异：去掉 Rating 的小数附注（游戏内只取整，非游戏值），
 * 补充评价字母一行；分档、上限截断（100.5）与错误文案均沿用原版口径。
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { computeRating, getBaseRa } from '../lib/calc.js'

const H = () => head()

/** `#mai com|calc|计算 <定数> <达成率>`；capture 1 = 参数串（无参也命中，由执行体回用法） */
const REG_COM = () => new RegExp(`^[#/]${H()}\\s*(?:com|calc|计算)(?:\\s+(.+))?$`)

/** 用法提示（原 maicom.js 的「格式错误QAQ！」口径） */
export function comUsage(cmdHead) {
  return `格式错误QAQ！\n格式：#${cmdHead} com <定数> <达成率>`
}

/** 解析失败的文案表（usage 走 comUsage，需命令头故单列） */
export const COM_ERROR_TEXT = {
  nan: '定数或达成率格式错误，应为数字！',
  ds: '定数应在0~15之间！',
  acc: '达成率应在0.0000%~101.0000%之间！',
}

/**
 * 解析参数串（原 maicom.js 语义收编）：两段空白分隔，达成率容忍尾随 %；
 * 范围沿用原版：定数 0~15、达成率 0~101（>100.5 的部分计算时截断）
 * @param {string} raw
 * @returns {{ds:number, acc:number} | {error:'usage'|'nan'|'ds'|'acc'}}
 */
export function parseComArgs(raw) {
  const args = (raw || '').trim().split(/\s+/).filter(Boolean)
  if (args.length < 2) return { error: 'usage' }
  let accRaw = args[1]
  if (accRaw.includes('%')) accRaw = accRaw.replace('%', '')
  const ds = parseFloat(args[0])
  const acc = parseFloat(accRaw)
  if (Number.isNaN(ds) || Number.isNaN(acc)) return { error: 'nan' }
  if (ds < 0 || ds > 15) return { error: 'ds' }
  if (acc < 0 || acc > 101) return { error: 'acc' }
  return { ds, acc }
}

/**
 * 计算并排版结果。评价系数 getBaseRa 与评分 computeRating 同源
 * （BASE_RA_SPP / computeRating 内部分档表一致），展示值必与评分自洽。
 * @param {number} ds 谱面定数
 * @param {number} acc 达成率（百分数值，如 100.5）
 */
export function formatComResult(ds, acc) {
  const coeff = getBaseRa(acc)
  const [rating, rate] = computeRating(ds, acc, { israte: true })
  return [
    `谱面定数：${ds.toFixed(1)}`,
    `达成率：${acc.toFixed(4)}%`,
    `评级系数：${coeff}`,
    `评价：${rate}`,
    `DX Rating：${rating}`,
  ].join('\n')
}

/** #mai com|calc|计算 <定数> <达成率>（收编自 plugins/example/maicom.js） */
export class MaiRating extends plugin {
  constructor() {
    super({
      name: 'mai-rating',
      dsc: '舞萌DX单曲Rating计算',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_COM().source, fnc: 'com' },
      ],
    })
  }

  async com(e) {
    const m = e.msg.match(REG_COM())
    if (!m) return false
    const parsed = parseComArgs(m[1])
    if (parsed.error) {
      await this.reply(parsed.error === 'usage' ? comUsage(H()) : COM_ERROR_TEXT[parsed.error], true)
      return true
    }
    await this.reply(formatComResult(parsed.ds, parsed.acc), true)
    return true
  }
}
