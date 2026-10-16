/**
 * #mai suggest —— 推分建议（docs/推分建议.md）
 *
 * 五个达成率目标档位（100.5/100.0/99.5/99.0/98.5）各推荐 5 张谱面；候选为各档
 * 推荐定数窗口内的**全部谱面**（玩过 + 未玩，排除宴谱/新歌），窗口由阈值 Rating
 * 推算（缺省 = 当前 Rating 向上取整到下一 500 档），目标每降一档窗口上移 0.5 定数。
 * 推荐度二选一：定数差值（默认）/ 平均达成率（`平均` 切换）。
 * 阈值 Rating 参数须 ≥ 当前 Rating。
 * 算法在 lib/suggest.js（纯函数），编排在 lib/handler.js drawSuggest。
 */
import { MaiPlugin } from '../lib/qqbot.js'
import { head } from '../lib/config.js'
import { getUserAndAuth } from '../lib/user.js'
import { drawSuggest } from '../lib/handler.js'
import { toSegment, botName } from '../lib/render/picmodle.js'
import { ensureReady } from '../lib/service.js'
import { parseSuggestArgs, suggestUsage, suggestArgError, suggestRatingError } from '../lib/suggest.js'

const H = () => head()

/** `#mai suggest [平均|定数] [阈值Rating]`；capture 1 = 参数串（无参也命中，默认口径直接出） */
const REG_SUGGEST = () => new RegExp(`^[#/]${H()}\\s*(?:suggest)(?:\\s+(.+))?$`)

/** #mai suggest —— 推分建议 */
export class MaiSuggest extends MaiPlugin {
  constructor() {
    super({
      name: 'mai-suggest',
      dsc: '舞萌DX推分建议',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_SUGGEST().source, fnc: 'suggest' },
      ],
    })
  }

  async suggest(e) {
    if (!(await ensureReady(e))) return true
    const m = e.msg.match(REG_SUGGEST())
    if (!m) return false
    const parsed = parseSuggestArgs(m[1])
    if (parsed.error) {
      await this.reply(parsed.error === 'arg'
        ? suggestArgError(parsed.token, H())
        : suggestRatingError(parsed.token), true)
      return true
    }
    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    const payload = await drawSuggest(got.user, parsed.mode, parsed.rating)
    await this.reply(toSegment(payload), true)
    return true
  }
}
