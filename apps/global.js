/**
 * #mai ginfo（源 commands/mai_score.py ginfo，设计 §3.2-18）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 难度色前缀（绿黄红紫白）→ level_index，默认紫(Master)；附全服统计文本。
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { drawSongGlobalData, getRatingRanking, rankNameText, rankListText, myRatingRankingText } from '../lib/handler.js'
import { toSegment } from '../lib/render/picmodle.js'
import { mai, ensureReady } from '../lib/service.js'
import { handleErrors } from '../lib/handlerError.js'
import { getUserAndAuth } from '../lib/user.js'
import { awaitPickSong, handlePickSong, findSongCandidates } from '../lib/pickSong.js'

const H = () => head()

const REG_GINFO = () => new RegExp(`^[#/]${H()}\\s+ginfo\\s+(.+)$`)
const REG_RANK = () => new RegExp(`^[#/]${H()}\\s+(?:rank|排行榜)(?:\\s+(.+))?$`)
const REG_MYRANK = () => new RegExp(`^[#/]${H()}\\s+(?:myrank|我的排名)\\s*$`)

const LEVEL_COLORS = '绿黄红紫白'

export class MaiGlobal extends plugin {
  constructor() {
    super({
      name: 'mai-global',
      dsc: '舞萌DX全服统计',
      event: 'message',
      priority: 100,
      rule: [
        { reg: `^[#/]${H()}\\s+ginfo\\s+(.+)$`, fnc: 'chartGlobal' },
        { reg: `^[#/]${H()}\\s+(?:rank|排行榜)(?:\\s+(.+))?$`, fnc: 'rank' },
        { reg: `^[#/]${H()}\\s+(?:myrank|我的排名)\\s*$`, fnc: 'myRank' },
      ],
    })
  }

  /** #mai rank <用户名|页>（df 公开排行；列表页=合并转发分组节点，降级分段文本） */
  async rank(e) {
    const args = ((e.msg.match(REG_RANK()) || [])[1] || '').trim()
    const data = await handleErrors(async () => await getRatingRanking())
    if (typeof data === 'string') {
      await this.reply(data, true)
      return true
    }
    if (args && !/^\d+$/.test(args)) {
      await this.reply(rankNameText({ ...data, name: args }), true)
      return true
    }
    const page = args ? parseInt(args, 10) : 1
    const meta = rankListText({ ...data, page })
    // 页头 + 行分组（≤10 行/节点）+ 页脚，节点数远低于宿主 100 上限
    const nodes = [meta.text.split('\n')[0]]
    const bodyLines = meta.text.split('\n').slice(1, -1)
    for (let i = 0; i < bodyLines.length; i += 10) nodes.push(bodyLines.slice(i, i + 10).join('\n'))
    nodes.push(meta.text.split('\n').slice(-1)[0])
    try {
      const common = (await import('../../../lib/common/common.js')).default
      const fwd = await common.makeForwardMsg(e, nodes)
      await this.reply(fwd, true)
    } catch {
      await this.reply(nodes.join('\n'), true)
    }
    return true
  }

  /** #mai myrank / #mai 我的排名（支持 @ 他人；源无错误捕获的缺陷此处经 handleErrors 补文案） */
  async myRank(e) {
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: true })
    if (!got) return true
    const text = await handleErrors(async () => await myRatingRankingText(got.user.qqid))
    await this.reply(text, true)
    return true
  }

  async chartGlobal(e) {
    if (!(await ensureReady(e))) return true
    let args = ((e.msg.match(REG_GINFO()) || [])[1] || '').trim()
    if (!args) {
      await this.reply('请输入曲目id或曲名', true)
      return true
    }

    let levelIndex = 3
    if (LEVEL_COLORS.includes(args[0])) {
      levelIndex = LEVEL_COLORS.indexOf(args[0])
      args = args.slice(1).trim()
      if (!args) {
        await this.reply('请输入曲目id或曲名', true)
        return true
      }
    }

    const found = findSongCandidates(args, mai)
    if (!found) {
      await this.reply('未找到曲目', true)
      return true
    }
    if (found.multi) {
      awaitPickSong(this, e, found.multi.map(a => mai.totalList.byId(a.song_id)).filter(Boolean), async (song) => {
        await this.sendGlobal(song, levelIndex)
      })
      return true
    }
    await this.sendGlobal(found.song, levelIndex)
    return true
  }

  async sendGlobal(song, levelIndex) {
    const e = this.e
    if (levelIndex >= song.difficulties.length) {
      await this.reply('该乐曲没有这个等级', true)
      return
    }
    const stats = song.difficulties[levelIndex].stats
    if (!stats) {
      await this.reply('该等级没有统计信息', true)
      return
    }
    const payload = await drawSongGlobalData(song, levelIndex)
    await this.reply(toSegment(payload), true)
  }

  /** 多候选选曲上下文（§3.4） */
  async pickSong() {
    return await handlePickSong(this)
  }
}
