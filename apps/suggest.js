/**
 * #mai suggest —— 推分建议（docs/推分建议.md）
 *
 * 五个达成率档位（进度分带）各推荐 5 张谱面；候选池为文档口径的推荐定数区间
 * （由 Rating 推算），推荐度二选一：平均达成率（默认）/ 定数差值（定数|差值|diff）。
 * 目标 Rating 可选（正整数，默认当前），需 ≥ 当前 Rating。
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

/** `#mai suggest [平均|定数] [目标Rating]`；capture 1 = 参数串（无参也命中，默认口径直接出） */
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
