/**
 * 猜歌 / 猜曲绘（源 `commands/mai_guess.py`，P3 实施文档 §4）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 *
 * **D5：起手必须带命令头** —— 设计原稿的「免前缀直发」作废。`猜歌`/`猜曲绘` 这种两三字的
 * 无头命令在日常聊天里极易误触发（且周边插件同样走命令头）。但**答题仍免前缀**
 * （游戏进行中用户就是直接打歌名/别名/id），靠「仅当该群处在游戏中才消费，否则 return false」
 * 把误触发窗口压到每局 82 秒、且仅限已 `on` 的群（`apps/guess.js` 的兜底类，priority 200）。
 *
 * 群开关是**白名单**（D4）：`lib/database.js:getGroup().guess` 默认 false，未显式开启的群不可用。
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import * as database from '../lib/database.js'
import { ensureReady } from '../lib/service.js'
import { drawChartInfo } from '../lib/handler.js'
import { toSegment } from '../lib/render/picmodle.js'
import { cropCover } from '../lib/render/crop.js'
import {
  startTextGame, startPicGame, finishCorrect, finishGame, endGame, isPlaying, isCorrect,
  getGuessPool, gameOf, startLetterGame, openLetter, tipLetter, answerLetter, letterBoardText,
} from '../lib/guess.js'

const H = () => head()

const REG_GUESS = () => new RegExp(`^[#/]${H()}\\s*(?:guess|猜歌)\\s*$`)
const REG_GUESSILL = () => new RegExp(`^[#/]${H()}\\s*(?:guessill|猜曲绘)\\s*$`)
const REG_GUESS_ONOFF = () => new RegExp(`^[#/]${H()}\\s*(?:guess\\s+(on|off|reset)|(开启|关闭|重置)猜歌)\\s*$`)
const REG_LETTER = () => new RegExp(`^[#/]${H()}\\s*(?:letter|ltr|开字母)\\s*$`)
/**
 * 翻开一个字母。**必须恰好一个字符**（`\s*([^\s])\s*$`），这同时排除了与起手命令的歧义：
 * `#mai 开字母` 在 `开` 之后还剩「字母」两字，故不匹配本规则、只会落在 REG_LETTER 上。
 * `(?:${H()}\s*)?` 让 `#open X` 与 `#mai open X` 都可用。
 */
const REG_OPEN = () => new RegExp(`^[#/](?:${H()}\\s*)?(?:open|翻开|打开|揭开|出|开)\\s*([^\\s])\\s*$`)
/** 随机翻开一个字符（对齐 phi 的 `getTip`；tips/tip 两种拼法都收） */
const REG_TIPS = () => new RegExp(`^[#/]${H()}\\s*(?:tips?|提示)\\s*$`)
/** 通用结束（三类游戏通吃）；权限在 handler 内判——不能用 permission，否则发起者被规则层拦死 */
const REG_ANS = () => new RegExp(`^[#/]${H()}\\s*(?:ans|答案)\\s*$`)
/** 答题兜底：免前缀、匹配一切，仅当该群在游戏中才消费（priority 200，见 MaiGuessAnswer） */
const REG_ANSWER = /^[\s\S]*$/

const ONOFF_CN = { 开启: 'on', 关闭: 'off', 重置: 'reset' }

/** 群管判定（宿主 `filtPermission` 同款字段） */
const isGroupAdmin = e => Boolean(e.isMaster || e.member?.is_owner || e.member?.is_admin)

/** 展示名（板面上标猜中者用） */
const displayName = e => String(e.sender?.card || e.sender?.nickname || e.user_id || '')

/** 该群已在进行的游戏类型 → 统一文案（源只提两类，第三类落地后必然失真，已登记） */
const busyHint = () => `该群已有正在进行的游戏（猜歌/猜曲绘/开字母），可发 #${H()} ans 结束或等它超时`

/** 群开关未开时的引导（源原文是「开启请输入 开启mai猜歌」；收编为子命令后改为本插件语法，已登记） */
const disabledHint = () => `该群已关闭猜歌功能，开启请输入 #${head()} guess on`

/** 揭晓卡载荷（源 `draw_chart_info(song)` + MESSAGE；失败时降级为文案） */
async function cardPayload(song) {
  const payload = await drawChartInfo(song, null)
  if (typeof payload === 'string') return payload
  return toSegment(Array.isArray(payload) ? payload : [payload])
}

/**
 * #mai guess（猜歌）/ #mai guessill（猜曲绘）/ #mai guess on|off|reset
 * 起手三条在 priority 100；答题兜底另起一类在 priority 200（必须先让所有主命令过一遍）
 */
export class MaiGuess extends plugin {
  constructor() {
    super({
      name: 'mai-guess',
      dsc: '舞萌DX猜歌',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_GUESS().source, fnc: 'startText' },
        { reg: REG_GUESSILL().source, fnc: 'startPic' },
        // 起手必须声明在 REG_OPEN 之前：`#mai 开字母` 两条都不冲突（见 REG_OPEN 注释），
        // 但顺序仍是「先起手、后动作」的自然读法
        { reg: REG_LETTER().source, fnc: 'startLetter' },
        { reg: REG_OPEN().source, fnc: 'open' },
        { reg: REG_TIPS().source, fnc: 'tips' },
        { reg: REG_ANS().source, fnc: 'ans' },
        { reg: REG_GUESS_ONOFF().source, fnc: 'toggle', permission: 'admin' },
      ],
    })
  }

  /** #mai letter / 开字母 —— 随机抽 N 首，曲名遮成 * ，靠开字母与直接猜答案推进 */
  async startLetter(e) {
    if (!e.isGroup) {
      await this.reply('开字母是群内游戏，请在群聊中发起。', true)
      return true
    }
    if (!(await ensureReady(e))) return true
    const gid = e.group_id
    if (!database.getGroup(gid).guess) {
      await this.reply(disabledHint(), true)
      return true
    }
    if (isPlaying(gid)) {
      await this.reply(busyHint(), true)
      return true
    }

    const game = startLetterGame(gid, {
      send: msg => e.reply(msg),
      starter: e.user_id,
      starterName: displayName(e),
    })
    if (!game) {
      await this.reply('曲库中可供开字母的曲目不足，无法开局。', true)
      return true
    }
    await this.reply(
      '开字母开始！直接发送曲名或别名即可作答（一条命中多首会一起判对）。\n'
      + '发送「#open 字母」翻开一个字母，如「#open J」；'
      + `发送「#${H()} ans」可提前结束并看答案。`,
      true,
    )
    await this.reply(letterBoardText(game), true)
    return true
  }

  /** #open X / #出X —— 翻开一个字母 */
  async open(e) {
    if (!(await ensureReady(e))) return true
    const letter = ((e.msg.match(REG_OPEN()) || [])[1] || '').trim()
    if (!letter) return false
    await openLetter(e.group_id, letter)
    return true
  }

  /** #mai tips / 提示 —— 开字母专用：随机翻开一个字符（对齐 phi 的 getTip） */
  async tips(e) {
    if (!(await ensureReady(e))) return true
    const r = await tipLetter(e.group_id)
    if (!r) {
      await this.reply('该群没有正在进行的开字母', true)
      return true
    }
    return true
  }

  /**
   * #mai ans / 答案 —— 三类游戏通用的提前结束
   * 权限 = 群管 **或** 本局发起者（故不能用 `permission:'admin'`，那会把发起者一并拦掉）
   */
  async ans(e) {
    if (!e.isGroup) {
      await this.reply('请在群聊中使用。', true)
      return true
    }
    const game = gameOf(e.group_id)
    if (!game) {
      await this.reply('该群没有正在进行的游戏', true)
      return true
    }
    if (!isGroupAdmin(e) && String(e.user_id ?? '') !== String(game.starter ?? '')) {
      await this.reply('只有群管或本局发起者可以结束游戏', true)
      return true
    }
    const parts = await finishGame(e.group_id)
    if (parts) await this.reply(parts, true)
    return true
  }

  /** #mai guess / 猜歌 —— 源 mai_guess.py:35-82 */
  async startText(e) {
    return await this.startGame(e, 'text')
  }

  /** #mai guessill / 猜曲绘 —— 源 mai_guess.py:85-114 */
  async startPic(e) {
    return await this.startGame(e, 'pic')
  }

  /** 起手共用：权限/开关/在局 三重守卫 → 抽曲 → 出裁片 → 建状态 */
  async startGame(e, type) {
    if (!e.isGroup) {
      await this.reply('猜歌是群内游戏，请在群聊中发起。', true)
      return true
    }
    if (!(await ensureReady(e))) return true
    const gid = e.group_id

    // 源的两处 finish 文案（猜歌不 quote、猜曲绘 quote，此处统一 quote，观感无差）
    if (!database.getGroup(gid).guess) {
      await this.reply(disabledHint(), true)
      return true
    }
    // 三类游戏互斥：一个群同时只允许一个（共用 lib/guess.js 的 games 注册表）
    if (isPlaying(gid)) {
      await this.reply(busyHint(), true)
      return true
    }

    const pool = getGuessPool()
    if (!pool.length) {
      await this.reply('猜歌池尚未就绪（曲库或全服统计缺失），请稍后再试。', true)
      return true
    }
    const song = pool[Math.floor(Math.random() * pool.length)]
    const img = await cropCover(song.song_id)
    if (typeof img === 'string') {
      await this.reply(img, true)
      return true
    }

    const opts = { song, img, send: msg => e.reply(msg), card: cardPayload }
    if (type === 'text') startTextGame(gid, opts)
    else startPicGame(gid, opts)
    return true
  }

  /** #mai guess on|off|reset / 开启(关闭|重置)猜歌 —— 源 mai_guess.py:132-153 + Guess.on/off */
  async toggle(e) {
    if (!e.isGroup) {
      await this.reply('猜歌是群内游戏，请在群聊中操作。', true)
      return true
    }
    const m = e.msg.match(REG_GUESS_ONOFF()) || []
    const action = m[1] || ONOFF_CN[m[2]]

    if (action === 'on') {
      database.updateGroup(e.group_id, { guess: true })
      await this.reply('群猜歌功能已开启', true)
      return true
    }
    if (action === 'off') {
      endGame(e.group_id) // 源 off 会顺手拆掉进行中的一局
      database.updateGroup(e.group_id, { guess: false })
      await this.reply('群猜歌功能已关闭', true)
      return true
    }
    // reset：源只清对局、不动群开关
    if (endGame(e.group_id)) await this.reply('已重置该群猜歌', true)
    else await this.reply('该群未处在猜歌状态', true)
    return true
  }
}

/**
 * 答题兜底（源 `on_message(rule=is_now_playing_guess_music)`）
 *
 * priority **200**：排在全部主命令（100）之后，故「猜歌时查歌等其他命令依然可用」——
 * 先让主命令有机会吃掉消息，剩下的才轮到这里裸答。
 * 未命中自身语义一律 `return false` 放行，绝不吞无关聊天。
 */
export class MaiGuessAnswer extends plugin {
  constructor() {
    super({
      name: 'mai-guess-answer',
      dsc: '舞萌DX猜歌答题',
      event: 'message',
      priority: 200,
      rule: [
        { reg: REG_ANSWER.source, fnc: 'onAnswer', log: false },
      ],
    })
  }

  /**
   * 答题兜底（三类游戏共用一条规则）
   *
   * 猜歌/猜曲绘与开字母的「直接发答案」语义不同，但**必须共用同一条 `^.*$` 规则**——
   * 两条兜底规则会互相抢消息。故这里按对局类型分流：
   * - 猜歌/猜曲绘：答对即揭晓并收尾（源 `mai_guess.py:117-129`）
   * - 开字母：答对只判该行，可继续开字母 / 猜其余行
   * 未命中一律 `return false` 放行（不吞无关聊天）。
   */
  async onAnswer(e) {
    if (!e.isGroup || !isPlaying(e.group_id)) return false
    const gid = e.group_id

    if (gameOf(gid)?.type === 'letter') {
      // 答错静默（与猜歌一致）；命中则由 lib 自行发送板面更新
      return (await answerLetter(gid, e.msg, displayName(e)))?.kind !== 'miss'
    }

    if (!isCorrect(gid, e.msg)) return false
    const parts = await finishCorrect(gid)
    if (!parts) return false
    await this.reply(parts, true)
    return true
  }
}
