/**
 * #mai b50 / ap50 / score（源 commands/mai_score.py 查询族，设计 §3.2-15/16/17）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * - b50/ap50：@他人可查（源 allow_at）；ap50 仅落雪
 * - score：曲名/id/别名 → 多候选走 pickSong 序号选择（§3.4）
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { getUserAndAuth } from '../lib/user.js'
import { drawBest50, drawPlayData } from '../lib/handler.js'
import { toSegment, botName } from '../lib/render/picmodle.js'
import { mai, ensureReady } from '../lib/service.js'
import { awaitPickSong, handlePickSong, findSongCandidates } from '../lib/pickSong.js'

const H = () => head()

const REG_B50 = () => new RegExp(`^[#/]${H()}\\s+(?:b50|B50)\\s*(.*)$`)
const REG_AP50 = () => new RegExp(`^[#/]${H()}\\s+(?:ap50|AP50)\\s*(.*)$`)
const REG_SCORE = () => new RegExp(`^[#/]${H()}\\s+(?:score|info|minfo|单曲成绩)\\s+(.+)$`)

export class MaiScore extends plugin {
  constructor() {
    super({
      name: 'mai-score',
      dsc: '舞萌DX查分',
      event: 'message',
      priority: 100,
      rule: [
        { reg: `^[#/]${H()}\\s+(?:b50|B50)\\s*(.*)$`, fnc: 'best50' },
        { reg: `^[#/]${H()}\\s+(?:ap50|AP50)\\s*(.*)$`, fnc: 'ap50' },
        { reg: `^[#/]${H()}\\s+(?:score|info|minfo|单曲成绩)\\s+(.+)$`, fnc: 'playData' },
      ],
    })
  }

  async best50(e) {
    return await this.queryBest50(e, false)
  }

  async ap50(e) {
    return await this.queryBest50(e, true)
  }

  async queryBest50(e, allPerfect) {
    if (!(await ensureReady(e))) return true
    const arg = (e.msg.match(allPerfect ? REG_AP50() : REG_B50()) || [])[1] || ''
    const username = arg.trim()

    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    const { user } = got

    // 源：ap50 仅落雪（用户名显式查询时走水鱼分支，allPerfect 自然忽略）
    if (allPerfect && user.service !== 'lxns') {
      await this.reply('仅落雪查分器支持AP50指令', true)
      return true
    }

    const payload = await drawBest50(user, { username, allPerfect })
    await this.reply(toSegment(payload), true)
    return true
  }

  async playData(e) {
    if (!(await ensureReady(e))) return true
    let arg = (e.msg.match(REG_SCORE()) || [])[1] || ''
    arg = arg.trim()
    // 帮助文案中的可选难度色参数：与 ginfo 语法对齐，尾部色字仅参与剥离（源 info 无按色过滤）
    const colorMatch = arg.match(/^.*?[\s]+[绿黄红紫白]$/)
    if (colorMatch) arg = arg.replace(/[\s]+[绿黄红紫白]$/, '').trim()

    if (!arg) {
      await this.reply('请输入曲目id或曲名', true)
      return true
    }

    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    const { user } = got

    const found = findSongCandidates(arg, mai)
    if (!found) {
      await this.reply('未找到曲目', true)
      return true
    }
    if (found.multi) {
      awaitPickSong(this, e, found.multi.map(a => mai.totalList.byId(a.song_id)).filter(Boolean), async (song) => {
        const payload = await drawPlayData(user, song)
        await this.reply(toSegment(payload), true)
      })
      return true
    }
    const payload = await drawPlayData(user, found.song)
    await this.reply(toSegment(payload), true)
    return true
  }

  /** 多候选选曲上下文（§3.4） */
  async pickSong(e) {
    return await handlePickSong(this, e)
  }
}
