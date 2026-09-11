/**
 * #mai ginfo（源 commands/mai_score.py ginfo，设计 §3.2-18）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 难度色前缀（绿黄红紫白）→ level_index，默认紫(Master)；附全服统计文本。
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import {
  FSLINE_ARGS_ERRORS, FSLINE_FORMAT_ERROR, FSLINE_HELP, drawFsline, drawSongGlobalData, fslineText,
  getRatingRanking, myRatingRankingText, rankListText, rankNameText,
} from '../lib/handler.js'
import { toSegment } from '../lib/render/picmodle.js'
import { mai, ensureReady } from '../lib/service.js'
import { handleErrors } from '../lib/handlerError.js'
import { getUserAndAuth } from '../lib/user.js'
import { awaitPickSong, handlePickSong, findSongCandidates } from '../lib/pickSong.js'

const H = () => head()

const REG_GINFO = () => new RegExp(`^[#/]${H()}\\s*ginfo\\s+(.+)$`)
const REG_RANK = () => new RegExp(`^[#/]${H()}\\s*(?:rank|排行榜)(?:\\s+(.+))?$`)
const REG_MYRANK = () => new RegExp(`^[#/]${H()}\\s*(?:myrank|我的排名)\\s*$`)
const REG_FSLINE = () => new RegExp(`^[#/]${H()}\\s*(?:fsline|分数线)(?:\\s+(.+))?$`)

const LEVEL_COLORS = '绿黄红紫白'

/**
 * 附加文本换算（`fslineText` 的容错包装）
 * 源口径在 `brk == 0` 时退化为格式错误文案，此时**没必要再补一行**，故返回空串
 */
function fslineTextSafe(song, levelIndex, line) {
  try {
    const text = fslineText(song, levelIndex, line)
    return text === FSLINE_FORMAT_ERROR ? '' : text
  } catch {
    return ''
  }
}

/**
 * 解析分数线参数 `[难度色]<曲名|id|别名> [达成率]`（纯函数，便于单测）
 *
 * **达成率可选**：只有末尾 token 能 parse 成数字时才算它。海报四张表全部只由物量推出、
 * 与达成率无关（见 lib/fsline.js），达成率仅驱动附加的那行文本。
 * **难度色位置可互换**：色字可融合在曲名前（`紫799`/`紫 799`），也可作为**独立 token** 放在
 * 末尾（`799 紫`）——后者要求整 token 恰为一个色字，不吞「以色字结尾」的曲名（`绝赞紫`
 * 仍整体当曲名查）。
 * @param {string} raw 命令头之后、去掉首尾空白的整段
 * @returns {{ok:true, levelIndex:number, query:string, line:number|null}
 *   | {ok:false, reason:'usage'|'missingQuery'|'missingColor'}} 失败时给原因，供调用方精确提示
 */
export function parseFslineArgs(raw) {
  const tokens = String(raw ?? '').split(/\s+/).filter(Boolean)
  if (!tokens.length) return { ok: false, reason: 'usage' }

  const last = tokens[tokens.length - 1]
  const hasLine = Number.isFinite(parseFloat(last))
  const rest = hasLine ? tokens.slice(0, -1) : tokens
  const line = hasLine ? parseFloat(last) : null
  if (!rest.length) return { ok: false, reason: 'usage' } // 只给了一个达成率

  // ① 色字在曲名前（可融合）
  if (LEVEL_COLORS.includes(rest[0][0])) {
    const query = [rest[0].slice(1), ...rest.slice(1)].join(' ').trim()
    return query
      ? { ok: true, levelIndex: LEVEL_COLORS.indexOf(rest[0][0]), query, line }
      : { ok: false, reason: 'missingQuery' }
  }
  // ② 色字是末尾的独立 token（整 token 恰为一个色字）
  if (rest.length > 1 && /^[绿黄红紫白]$/.test(rest[rest.length - 1])) {
    return { ok: true, levelIndex: LEVEL_COLORS.indexOf(rest[rest.length - 1]), query: rest.slice(0, -1).join(' ').trim(), line }
  }
  return { ok: false, reason: 'missingColor' }
}

export class MaiGlobal extends plugin {
  constructor() {
    super({
      name: 'mai-global',
      dsc: '舞萌DX全服统计',
      event: 'message',
      priority: 100,
      rule: [
        { reg: `^[#/]${H()}\\s*ginfo\\s+(.+)$`, fnc: 'chartGlobal' },
        { reg: `^[#/]${H()}\\s*(?:rank|排行榜)(?:\\s+(.+))?$`, fnc: 'rank' },
        { reg: `^[#/]${H()}\\s*(?:myrank|我的排名)\\s*$`, fnc: 'myRank' },
        { reg: REG_FSLINE().source, fnc: 'fsline' },
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

  /**
   * #mai fsline [难度色]<曲名|id|别名> <目标达成率>（源 commands/mai_score.py:113 分数线）
   *
   * 与源的差异（设计 §3.2-19 + 用户拍板）：
   *  1. 源只认 `<难度色><纯数字id>`；此处把查曲扩展为与 song/score 同一管线（曲名/别名/id），
   *     多候选走既有 pickSong 引导；
   *  2. 达成率**可选**：取最后一个 token 且仅当它能 parse 成数字（海报四表与达成率无关，
   *     见 lib/fsline.js）；难度色可融合在曲名前（源靠 `\s?`）或作为独立 token 放在曲名后
   *     （用户反馈的 `799 紫` 习惯形态）；
   *  3. 帮助为纯文本（源走 text_to_bytes_io 转图，设计 §6.4 已废除长文本转图）。
   */
  async fsline(e) {
    if (!(await ensureReady(e))) return true
    const raw = ((e.msg.match(REG_FSLINE()) || [])[1] || '').trim()
    const args = raw.split(/\s+/).filter(Boolean)

    if (args.length && args[0] === '帮助') {
      await this.reply(FSLINE_HELP, true)
      return true
    }

    const parsed = parseFslineArgs(raw)
    if (!parsed.ok) {
      await this.reply(FSLINE_ARGS_ERRORS[parsed.reason], true)
      return true
    }
    const { levelIndex, query, line } = parsed

    // 纯数字 → id 直查（源的唯一形态）
    if (/^\d+$/.test(query)) {
      const song = mai.totalList.byId(parseInt(query, 10))
      if (!song) {
        // 格式没错、只是 id 不存在：按查曲失败提示（与曲名查不到同一文案），不再笼统报格式错误
        await this.reply('未找到曲目', true)
        return true
      }
      await this.sendFsline(song, levelIndex, line)
      return true
    }

    const found = findSongCandidates(query, mai)
    if (!found) {
      await this.reply('未找到曲目', true)
      return true
    }
    if (found.multi) {
      awaitPickSong(this, e, found.multi.map(a => mai.totalList.byId(a.song_id)).filter(Boolean), async (song) => {
        await this.sendFsline(song, levelIndex, line)
      })
      return true
    }
    await this.sendFsline(found.song, levelIndex, line)
    return true
  }

  /**
   * 分数线回复：出海报（四表由物量推出，见 lib/fsline.js）
   *
   * - 给了达成率 ⇒ 图之外**再附一行**现有文本（`fslineText` 原样保留为附加信息）
   * - 渲染失败 ⇒ 有达成率就退回只发文本；没有则把渲染错误亮出来（否则用户看不到任何反馈）
   */
  async sendFsline(song, levelIndex, line = null) {
    if (levelIndex >= song.difficulties.length) {
      // 与 sendGlobal 同文案：格式没错，只是该曲没有这个难度（如无 Re:Master 的曲选了白）
      await this.reply('该乐曲没有这个等级', true)
      return
    }

    const image = await drawFsline(song, levelIndex)
    if (typeof image === 'string') {
      const fallback = line == null ? image : fslineTextSafe(song, levelIndex, line)
      await this.reply(fallback, true)
      return
    }
    await this.reply(toSegment(image), true)

    if (line != null) {
      const text = fslineTextSafe(song, levelIndex, line)
      if (text) await this.reply(text, true)
    }
  }

  /** 多候选选曲上下文（§3.4） */
  async pickSong() {
    return await handlePickSong(this)
  }
}
