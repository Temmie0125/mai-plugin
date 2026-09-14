/**
 * #mai b50 / ap50 / score / 拟合b50 / update（源 commands/mai_score.py 查询族，设计 §3.2-15/16/17）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * - b50/ap50：@他人可查（源 allow_at）；ap50 仅落雪
 * - score：曲名/id/别名 → 多候选走 pickSong 序号选择（§3.4）
 * - 拟合b50：按曲库拟合定数重算的 B50（可 @他人）；不支持用户名方式（D5）
 * - update：刷新并缓存**本人**的 b50 + 全量成绩（D6 仅本人）
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { getUserAndAuth } from '../lib/user.js'
import { drawBest50, drawPlayData, drawFitBest50, updatePlayerCache } from '../lib/handler.js'
import { toSegment, botName } from '../lib/render/picmodle.js'
import { mai, ensureReady } from '../lib/service.js'
import { awaitPickSong, handlePickSong, findSongCandidates } from '../lib/pickSong.js'

const H = () => head()

const REG_B50 = () => new RegExp(`^[#/]${H()}\\s*(?:b50|B50)\\s*(.*)$`)
const REG_AP50 = () => new RegExp(`^[#/]${H()}\\s*(?:ap50|AP50)\\s*(.*)$`)
const REG_SCORE = () => new RegExp(`^[#/]${H()}\\s*(?:score|info|minfo|单曲成绩)(?:\\s+(.+))?$`)

/**
 * 拟合b50 / update 的正则（规则与 fnc 内解析**共用同一来源**，避免两处漂移）
 *
 * ⚠️ 参数捕获刻意用 `(?:\\s+(.+))?\\s*$`（`REG_SCORE` 同款严格风格），**不要**照抄
 * `REG_B50` 的 `\\s*(.*)$`：
 *   - 用 `(.*)$` 时 `#mai 拟合b50x` 会命中（arg=`x`），与 §7.1 的拒收断言矛盾；
 *   - 改严格 `\\s*$` 则 `#mai 拟合b50 张三` 整体不命中，使 D5 的引导**永不可达**
 *     （命令静默无回复）。
 * 本式同时满足：子命令←参数必须空格、容忍尾随空格、带参数时引导可达。
 *
 * 关于 @他人：宿主 `lib/plugins/loader.js:377-407` 的 `dealEvent` 是**从 e.message 重建**
 * e.msg 的，只拼接 text 段，at 段只写 `e.at` 而不进 e.msg。所以 `#mai 拟合b50 @某人`
 * 的 e.msg 就是 `#mai 拟合b50`，参数捕获为空 —— @查询不会被这里误判为「用户名方式」。
 */
const REG_FIT = () => new RegExp(`^[#/]${H()}\\s*(?:拟合[bB]50|fix[bB]50)(?:\\s+(.+))?\\s*$`)
const REG_UPDATE = () => new RegExp(`^[#/]${H()}\\s*[uU]pdate\\s*$`)

export class MaiScore extends plugin {
  constructor() {
    super({
      name: 'mai-score',
      dsc: '舞萌DX查分',
      event: 'message',
      priority: 100,
      rule: [
        { reg: `^[#/]${H()}\\s*(?:b50|B50)\\s*(.*)$`, fnc: 'best50' },
        { reg: `^[#/]${H()}\\s*(?:ap50|AP50)\\s*(.*)$`, fnc: 'ap50' },
        { reg: `^[#/]${H()}\\s*(?:score|info|minfo|单曲成绩)(?:\\s+(.+))?$`, fnc: 'playData' },
        // 拟合b50 / update：规则串取 REG_*().source，保证与 fnc 内解析用同一份正则
        { reg: REG_FIT().source, fnc: 'fitB50' },
        { reg: REG_UPDATE().source, fnc: 'updateScore' },
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
    // 兼容容错：旧输入习惯可能带尾部难度色（如「score 茄子 紫」）——成绩卡含全难度，
    // 难度参数无意义（帮助已不宣传），此处仅剥离不报错
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
  async pickSong() {
    return await handlePickSong(this)
  }

  /**
   * `#mai 拟合b50` / `#mai fixB50`：按拟合定数重算的 B50（设计 §7.2）
   *
   * 不支持用户名显式查询（D5）：成绩缓存**按请求者的用户键归属**，而用户名流的数据
   * 属于被点名者，入缓存会把他人成绩记在请求者名下。@他人不受影响——此时 user 本身
   * 就是目标用户，按目标键写入是正确的。
   */
  async fitB50(e) {
    if (!(await ensureReady(e))) return true
    const arg = ((e.msg || '').match(REG_FIT()) || [])[1] || ''

    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true

    if (arg.trim()) {
      await this.reply('拟合b50 按绑定账号查询（可 @ 他人）；暂不支持用户名方式。', true)
      return true
    }

    const payload = await drawFitBest50(got.user)
    await this.reply(toSegment(payload), true)
    return true
  }

  /**
   * `#mai update`：刷新并缓存**本人**的 b50 + 全量成绩（设计 §7.3，D6 仅本人）
   * 编排在 lib/handler.js:updatePlayerCache（含 handleErrors），此处只做规则与回复。
   */
  async updateScore(e) {
    if (!(await ensureReady(e))) return true
    const got = await getUserAndAuth(e, { requireAuth: true, allowAt: false, botName: botName() })
    if (!got) return true

    await this.reply(toSegment(await updatePlayerCache(got.user)), true)
    return true
  }
}
