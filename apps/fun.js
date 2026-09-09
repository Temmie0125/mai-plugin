/**
 * 口语「…mai…什么…」随机/推分推荐（源 commands/mai_base.py mai_what，设计 §3.2-10）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 无命令头正则，priority 1500 后置；处理后 return false 放行（源非阻塞语义）。
 * 今日舞萌/随机谱面/上分推荐等 P3 接入。
 */
import plugin from '../../../lib/plugins/plugin.js'
import { getUserAndAuth } from '../lib/user.js'
import { drawChartInfo, getMaiWhat } from '../lib/handler.js'
import { toSegment, botName } from '../lib/render/picmodle.js'
import { mai } from '../lib/service.js'

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
