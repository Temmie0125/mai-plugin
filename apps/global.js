/**
 * #mai ginfo（源 commands/mai_score.py ginfo，设计 §3.2-18）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 难度色前缀（绿黄红紫白）→ level_index，默认紫(Master)；附全服统计文本。
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { drawSongGlobalData } from '../lib/handler.js'
import { toSegment } from '../lib/render/picmodle.js'
import { mai, ensureReady } from '../lib/service.js'
import { awaitPickSong, handlePickSong, findSongCandidates } from '../lib/pickSong.js'

const H = () => head()

const REG_GINFO = () => new RegExp(`^[#/]${H()}\\s+ginfo\\s+(.+)$`)

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
      ],
    })
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
  async pickSong(e) {
    return await handlePickSong(this, e)
  }
}
