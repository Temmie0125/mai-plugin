/**
 * #mai rise / 口语推分（源 commands/mai_base.py:158 rise_score，设计 §3.2-12）
 * 与口语「…mai…什么…」随机/推分推荐（源 mai_what，设计 §3.2-10）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { getUserAndAuth } from '../lib/user.js'
import { drawChartInfo, drawRiseScoreList, getMaiWhat } from '../lib/handler.js'
import { toSegment, botName } from '../lib/render/picmodle.js'
import { ensureReady, mai } from '../lib/service.js'
import { LEVEL_LIST } from '../lib/constants.js'

const H = () => head()

const REG_RISE = () => new RegExp(`^[#/]${H()}\\s*(?:rise|推分)(?:\\s+(\\S+))?(?:\\s+(\\d+))?\\s*$`)
/** 源触发词原文：`我要在?([0-9]+\+?)?[上加\+]([0-9]+)?分\s?(.+)?` */
const REG_RISE_SAY = () => /^我要在?([0-9]+\+?)?[上加\+]([0-9]+)?分\s?(.+)?/

/** 解析等级/分数字面（源 rise_score.handle：score 非 None 才 int()） */
export function parseRiseArgs(levelRaw, scoreRaw) {
  const level = levelRaw || null
  const score = scoreRaw == null || scoreRaw === '' ? null : parseInt(scoreRaw, 10)
  return { level, score }
}

export class MaiRise extends plugin {
  constructor() {
    super({
      name: 'mai-rise',
      dsc: '舞萌DX上分推荐',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_RISE().source, fnc: 'riseScore' },
      ],
    })
  }

  /** #mai rise [等级] [分数] —— 源 mai_base.py:386 rise_score.handle */
  async riseScore(e) {
    if (!(await ensureReady(e))) return true
    const m = e.msg.match(REG_RISE()) || []
    const { level, score } = parseRiseArgs(m[1], m[2])
    if (level && !LEVEL_LIST.includes(level)) {
      await this.reply('无此等级', true)
      return true
    }
    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    const payload = await drawRiseScoreList(got.user, level, score)
    await this.reply(toSegment(payload), true)
    return true
  }
}

/**
 * 口语「我要在13+上1分」 —— 源 rise_score 的免前缀形态（设计 §3.2-12 保留）
 * priority 1500、log:false；未命中语义一律 return false 放行
 */
export class MaiRiseSay extends plugin {
  constructor() {
    super({
      name: 'mai-rise-say',
      dsc: '舞萌DX口语上分推荐',
      event: 'message',
      priority: 1500,
      rule: [
        { reg: REG_RISE_SAY().source, fnc: 'riseSay', log: false },
      ],
    })
  }

  async riseSay(e) {
    const m = e.msg.match(REG_RISE_SAY())
    if (!m) return false
    if (!(await ensureReady(e))) return false
    const { level, score } = parseRiseArgs(m[1], m[2])
    if (level && !LEVEL_LIST.includes(level)) {
      await this.reply('无此等级', true)
      return true
    }
    const got = await getUserAndAuth(e, { requireAuth: true, checkSkip: true, botName: botName() })
    if (!got) return true
    const payload = await drawRiseScoreList(got.user, level, score)
    await this.reply(toSegment(payload), true)
    return true
  }
}

/** 口语「…mai…什么…」随机 / 推分（源 mai_what，设计 §3.2-10，P1 已交付） */
export class MaiFun extends plugin {
  constructor() {
    super({
      name: 'mai-fun',
      dsc: '舞萌DX口语互动',
      event: 'message',
      priority: 1500,
      rule: [
        { reg: '.*mai.*什么(.+)?', fnc: 'maiWhat', log: false },
      ],
    })
  }

  async maiWhat(e) {
    // 口语规则静默降级：未就绪时静默重试一次，失败不回复（不打扰普通聊天）
    if (!mai.ready && !(await mai.init().catch(() => false))) return false
    const match = e.msg.match(/.*mai.*什么(.+)?/)
    if (!match) return false

    const got = await getUserAndAuth(e, { requireAuth: true, checkSkip: true, botName: botName() })
    const user = got?.user ?? null

    let song = mai.totalList.random()
    const point = match[1]
    if (point && (point.includes('推分') || point.includes('上分') || point.includes('加分')) && user) {
      // getMaiWhat 异常时 handleErrors 返回文案字符串，视作无推荐（规避源将错误段误当曲目的边角）
      const recommended = await getMaiWhat(user)
      if (recommended != null && typeof recommended !== 'string') song = recommended
    }
    const payload = await drawChartInfo(song, user)
    await this.reply(toSegment(payload), true)
    return false
  }
}
