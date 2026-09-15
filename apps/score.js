/**
 * #mai b50 / ap50 / score / 拟合b50 / update / 随心配b50（源 commands/mai_score.py 查询族，设计 §3.2-15/16/17）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * - b50/ap50：@他人可查（源 allow_at）；ap50 落雪走接口、水鱼由本地全量成绩算（b50扩展设计 V4/V12）
 * - score：曲名/id/别名 → 多候选走 pickSong 序号选择（§3.4）
 * - 拟合b50：按曲库拟合定数重算的 B50（可 @他人）；不支持用户名方式（D5）
 * - update：刷新并缓存**本人**的 b50 + 全量成绩（D6 仅本人）
 * - 随心配b50：按条件定制的 B50 家族（FC50/单刷50/东方50/全13b50/歌50…），
 *   解析层在 lib/variantSpec.js，规则与解析共用同一份 token 表（见该文件头）
 */
import plugin from '../../../lib/plugins/plugin.js'
import Config, { head } from '../lib/config.js'
import { checkReadiness } from '../lib/render/assets.js'
import pkg from '../package.json' with { type: 'json' }
const { version } = pkg
import { getUserAndAuth, effectiveService } from '../lib/user.js'
import {
  drawBest50, drawPlayData, drawFitBest50, drawSong50, drawVariantBest50, updatePlayerCache,
} from '../lib/handler.js'
import { toSegment, botName, renderVariantHelp } from '../lib/render/picmodle.js'
import { mai, ensureReady } from '../lib/service.js'
import { awaitPickSong, handlePickSong, findSongCandidates } from '../lib/pickSong.js'
import {
  DIFF_COLORS, collectDesigners, isTimeKeyword, resolveAllCondition, resolveDesigner, resolveVariant,
  variantTokenPattern,
} from '../lib/variantSpec.js'

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

/**
 * 随心配b50 家族的正则（设计 §3.4）
 *
 * ⚠️ **声明序即匹配序**：这 5 条必须排在 b50/ap50/score/拟合/update **之后**（同类内声明序确定，
 *    跨 plugin 类的先后不可控）——`REG_ALL50`（`全…b50`）与兜底规则都依赖「真实 B50 先被尝试」。
 * ⚠️ token 白名单由 lib/variantSpec.js 生成（与解析器、帮助图同一份来源），
 *    其中的 ASCII 字母已做大小写折叠（宿主以 new RegExp(reg) 编译规则，传不了 'i' 标志）。
 */
const REG_VARIANT_HELP = () => new RegExp(`^[#/]${H()}\\s*随心配(?:[bB]50)?(?:\\s*(?:[hH]elp|帮助))?\\s*$`)
const REG_SONG50 = () => new RegExp(`^[#/]${H()}\\s*歌50(?:\\s+(.+))?\\s*$`)
const REG_ALL50 = () => new RegExp(`^[#/]${H()}\\s*全(.+?)b50\\s*$`)
// ⚠️ 这里必须是**捕获组** `(…)`，不能写成非捕获组 `(?:…)`：
// fnc 要用 m[1] 取回 token，写错则 raw 恒为 ''、解析失败、return false 放行 ——
// 表现为「命令被认领但永远没有回复、日志里连完成行都没有」（2026-09-15 真机踩过）
const REG_VARIANT50 = () => new RegExp(`^[#/]${H()}\\s*(${variantTokenPattern()})50\\s*$`)
/**
 * 谱师兜底规则：谱师名含空格（`Moon Strix`）与 `@`/`-`，塞不进单 token 白名单，故单独一条。
 * ⚠️ **未命中一律 `return false` 放行**（宿主 loader.js:303 `if (res === false) continue`）——
 *    没有这条语义时，`#mai song 1150`、`#mai list 1350`、`#mai search 定数50` 会被它吞掉。
 *    日志降为 debug：绝大多数消息会走到这里再放行。
 */
const REG_DESIGNER50 = () => new RegExp(`^[#/]${H()}\\s*(.{1,20}?)50\\s*$`)

/** 时间类迁移引导（V26：新歌/旧版本 已整族移出 b50） */
const timeGuideText = () => [
  '按时间筛选不参与 B50（B35/B15 分区会让人误读「哪个区才是新版」），已并入分数列表：',
  `・「#${H()} list 新歌」 / 「#${H()} 新歌分数列表」`,
  `・「#${H()} list 旧版本」 / 「#${H()} 旧版本分数列表」`,
].join('\n')

/** 难度色是否单字（'紫' / '红' 之类） */
const isDiffColor = ch => ch.length === 1 && DIFF_COLORS.includes(ch)

/**
 * 解析「歌50」的参数：`[难度色]<曲名|id|别名>`，难度色可与曲名交换、也可与曲名粘连
 *
 * 粘连形态（`紫茄子` / `红799`）**先剥离色字再查曲**，查不到则整体当曲名重试——
 * 这样 `紫茄子` 得到「紫谱 + 茄子」，而名字本身以色字开头的曲目（如「红莲」）仍可整体命中。
 *
 * @returns {{color:string|null, query:string}}
 */
export function parseSong50Args(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return { color: null, query: '' }
  const last = tokens[tokens.length - 1]
  const first = tokens[0]
  if (tokens.length > 1 && isDiffColor(last)) {
    return { color: last, query: tokens.slice(0, -1).join(' ') }
  }
  if (tokens.length > 1 && isDiffColor(first)) {
    return { color: first, query: tokens.slice(1).join(' ') }
  }
  if (tokens.length === 1 && first.length > 1 && isDiffColor(first[0])) {
    return { color: first[0], query: first.slice(1) }
  }
  return { color: null, query: tokens.join(' ') }
}

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
        // 随心配b50 家族：**必须排在最后**（声明序即匹配序，见 REG_* 注释）
        { reg: REG_VARIANT_HELP().source, fnc: 'variantHelp' },
        { reg: REG_SONG50().source, fnc: 'song50' },
        { reg: REG_ALL50().source, fnc: 'all50' },
        { reg: REG_VARIANT50().source, fnc: 'variant50' },
        { reg: REG_DESIGNER50().source, fnc: 'designer50', log: false },
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

    // ap50：落雪走 `/bests/ap` 接口（实时）；水鱼无该接口 ⇒ 由本地全量成绩算（b50扩展设计 V4/V8）。
    // 但**用户名方式**在水鱼侧不支持（V12）：records 缓存按请求者键归属，代查他人会串号；
    // 而按用户名现拉全量又得在「写缓存」的护栏上开洞（D17）。@他人已覆盖「查朋友」的需求。
    if (allPerfect && username && effectiveService(user) !== 'lxns') {
      await this.reply(`水鱼 AP50 仅支持绑定账号查询（可 @ 他人）；用户名方式请改用落雪数据源，或「#${H()} bind qq <QQ号>」后按账号查询。`, true)
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

  /**
   * `#mai 随心配[b50] [help|帮助]`：分支说明专题图（设计 §7.3 / V7）
   *
   * 与主帮助图同款：只需静态资源在位，**不需要曲库**（故用 checkReadiness 而非 ensureReady）。
   */
  async variantHelp(e) {
    const ready = checkReadiness()
    if (!ready.ready) {
      await this.reply(
        `未检测到静态资源包（当前曲绘 ${ready.count} 张），无法渲染图片。\n` +
          `请阅读插件 README「安装与资源」：以主人权限执行「${H()} download」后重启。`
      )
      return true
    }
    const payload = await renderVariantHelp(Config.getUserCfg('config', 'cmdhead'), `v${version}`)
    await this.reply(toSegment(payload))
    return true
  }

  /**
   * `#mai 歌50 [难度色]<曲名|id|别名>`：整张 B50 全是同一首歌（V1）
   * 多候选同样走 pickSong 序号选择（与 `#mai score` 一致）
   */
  async song50(e) {
    if (!(await ensureReady(e))) return true
    const raw = ((e.msg || '').match(REG_SONG50()) || [])[1] || ''
    if (!raw.trim()) {
      await this.reply(`请输入曲目，例如「#${H()} 歌50 紫茄子」或「#${H()} 歌50 799 红」。`, true)
      return true
    }
    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true

    const { color, query } = parseSong50Args(raw)
    // 粘连色字（紫茄子）：先按剥离后的曲名查；查不到再整体当曲名重试
    let found = query ? findSongCandidates(query, mai) : null
    let levelIndex = color ? DIFF_COLORS.indexOf(color) : null
    if (!found && color) {
      found = findSongCandidates(color + query, mai)
      levelIndex = null
    }
    if (!found) {
      await this.reply('未找到曲目', true)
      return true
    }

    if (found.multi) {
      awaitPickSong(this, e, found.multi.map(a => mai.totalList.byId(a.song_id)).filter(Boolean), async (song) => {
        await this.reply(toSegment(await drawSong50(got.user, song, levelIndex)), true)
      })
      return true
    }
    await this.reply(toSegment(await drawSong50(got.user, found.song, levelIndex)), true)
    return true
  }

  /** `#mai 全<定数|难度色>b50`：整张 B50 全部由符合条件的谱面构成（V2：与 红谱50 等价） */
  async all50(e) {
    if (!(await ensureReady(e))) return true
    const raw = ((e.msg || '').match(REG_ALL50()) || [])[1] || ''
    const spec = resolveAllCondition(raw)
    if (!spec) {
      await this.reply(`无法识别的条件「${raw.trim()}」。支持定数（如 13、13+、13.5）或难度色（如 红、红谱）。`, true)
      return true
    }
    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    await this.reply(toSegment(await drawVariantBest50(got.user, spec)), true)
    return true
  }

  /** `#mai <条件>50`：随心配白名单 token（条件词/评级族/分类/版本/类型/难度） */
  async variant50(e) {
    if (!(await ensureReady(e))) return true
    const raw = ((e.msg || '').match(REG_VARIANT50()) || [])[1] || ''
    const spec = resolveVariant(raw)
    // 正则已白名单化，理论不可达；真到了这里**放行**比报错好（宿主会继续尝试后续规则）
    if (!spec) return false

    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    await this.reply(toSegment(await drawVariantBest50(got.user, spec)), true)
    return true
  }

  /**
   * `#mai <谱师>50`（兜底规则，log:false）
   *
   * ⚠️ 未命中谱师**一律 `return false` 放行**，否则 `#mai song 1150`（id 以 50 结尾）、
   * `#mai list 1350`、`#mai search 定数50` 都会被吞掉（设计 §3.4 R1）。
   * 时间词（新歌/旧版本）在此回迁移引导 —— 它们与谱师共用「任意文本 + 50」的形状。
   */
  async designer50(e) {
    const raw = ((e.msg || '').match(REG_DESIGNER50()) || [])[1] || ''
    const token = raw.trim()
    if (!token) return false

    // 时间词：回迁移引导（不需要曲库，故在就绪判断之前处理）
    if (isTimeKeyword(token)) {
      await this.reply(timeGuideText(), true)
      return true
    }
    // ⚠️ 谱师判定要查曲库，但**不能用 ensureReady**：它会在未就绪时回一句「曲库尚未就绪」，
    //    而这条规则对绝大多数消息（`#mai song 1150` 之类）只是路过 —— 那就成了抢答 + 双回复。
    //    未就绪一律静默放行，交给真正认领该消息的规则去提示。
    if (!mai.ready) return false

    const spec = resolveDesigner(token, { designers: collectDesigners(mai.totalList) })
    if (!spec) return false                                  // ★ 放行：别的规则/插件接手

    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    await this.reply(toSegment(await drawVariantBest50(got.user, spec)), true)
    return true
  }
}
