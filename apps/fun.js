/**
 * #mai rise / 口语推分（源 commands/mai_base.py:158 rise_score，设计 §3.2-12）
 * 与口语「…mai…什么…」随机/推分推荐（源 mai_what，设计 §3.2-10）
 * 今日舞萌 fortune（源 mai_base.py:310-337，P3 实施文档 §5）
 * 随机谱面 rand（源 mai_base.py:357-385，P3 实施文档 §6）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 */
import fs from 'node:fs'
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { getUserAndAuth } from '../lib/user.js'
import { drawChartInfo, drawRiseScoreList, getMaiWhat } from '../lib/handler.js'
import { toSegment, botName } from '../lib/render/picmodle.js'
import { ensureReady, mai } from '../lib/service.js'
import { LEVEL_LIST } from '../lib/constants.js'
import { songChartFile } from '../lib/render/assets.js'
import { buildFortune } from '../lib/fortune.js'
import { pyFloat } from '../lib/render/textwidth.js'

const H = () => head()

/** 源 `^[随来给]个((?:dx|sd|标准))?([绿黄红紫白]?)([0-9]+\+?).*`（re.IGNORECASE）
 *  规则字符串带不了 flags，故 dx/sd 显式写大小写两态，判型时再统一 toLowerCase */
const REG_RAND_SAY = () => /^[随来给]个([Dd][Xx]|[Ss][Dd]|标准)?([绿黄红紫白]?)([0-9]+\+?).*/
/** 收编后的子命令形态（设计 §3.2-11）：`#mai rand dx紫14` / `#mai 随机 白13` */
const REG_RAND = () => new RegExp(`^[#/]${H()}\\s*(?:rand|随机)(?:\\s+(.+))?$`)
/** 源 `on_command("今日舞萌")`；收编后补英文子命令 fortune 与 phi 系的 jrrp */
const REG_FORTUNE = () => new RegExp(`^[#/]${H()}\\s*(?:fortune|jrrp|今日舞萌)\\s*$`)
/** 免前缀形态：中文语义已足够明确（完整名词短语 + 舞萌专有词），不会被日常对话误触发。
 *  前缀可选，故 `#今日舞萌` 与 `今日舞萌` 都能用。与 D5 收敛「猜歌/猜曲绘」不冲突——
 *  那是两三个字的动词短语，误触发面远大于此。 */
const REG_FORTUNE_SAY = () => /^[#/]?今日舞萌\s*$/

const RAND_COLORS = '绿黄红紫白'

/**
 * 解析随机谱面条件（源 `mai_base.py:363-377` 的 group 语义）
 * 顺序固定为「类型 颜色 定数」，与源正则一致。
 *
 * ⚠️ 与源的差异（刻意，对齐帮助里的 `[类型][颜色][定数]` 与 phi 的 `rand`）：
 * 源的口语正则里定数是**必需**的（`[0-9]+\+?` 无 `?`），而子命令形态三段**都可省略**——
 * 不给任何条件即「全曲库随机」（phi 同命令无参时 `top=100, bottom=0`，等价语义）。
 * 口语形态仍要求定数（`来个` 这种两字头太容易误触发）。
 *
 * @param {string} raw 用户输入的条件串（空串/纯空白 ⇒ 全默认值）
 * @returns {{types: string[], color: string, level: string} | null} 含无法识别字符时 null
 */
export function parseRandArgs(raw) {
  const m = (raw || '').trim().toLowerCase().match(/^(dx|sd|标准)?([绿黄红紫白])?([0-9]+\+?)?$/)
  if (!m) return null
  const [, type, color = '', level = ''] = m
  const types = type === 'dx' ? ['DX'] : (type === 'sd' || type === '标准') ? ['SD'] : ['SD', 'DX']
  return { types, color, level }
}

/**
 * 按条件筛曲（源 `mai_base.py:369-377`）：先按类型/定数 filter，再按颜色位次核对该难度定数
 * @returns {any[] | null} 命中的曲目（保留全部难度，与源 `filter(all_diff=True)` 一致）；条件不可解析时 null
 */
export function filterRandSongs(raw) {
  const parsed = parseRandArgs(raw)
  if (!parsed) return null
  const { types, color, level } = parsed
  // 定数省略即不限，故 filter 只带类型；全空时 filter({type:['SD','DX']}) 等价全曲库
  let songs = mai.totalList.filter(level ? { level, type: types } : { type: types })
  if (color) {
    const ci = RAND_COLORS.indexOf(color)
    // 颜色本是定数的限定词；没有定数时退化为「该难度位次存在」的过滤
    songs = songs.filter(s => s.difficulties.length > ci
      && (!level || s.difficulties[ci].level === level))
  }
  return songs
}

/**
 * 今日舞萌文案（源 `mai_base.py:320-332` 逐行直译）
 * 与呈现分离：将来接 fortune.html 时只换 sendFortune，本函数与其单测不动（P3 §5.5）
 * @param {{rp:number, good:string[], bad:string[], song:any}} data
 * @param {string} bot BOT 名称
 */
export function fortuneText({ rp, good, bad, song }, bot) {
  return [
    `今日人品值：${rp}`,
    // D6：源的宜/忌是「不定项数逐行」，本插件固定 4 项，改单行 ` / ` 连接更紧凑
    `宜 ${good.join(' / ')}`,
    `忌 ${bad.join(' / ')}`,
    // 源为 `...哦\n今日推荐歌曲：` + `ID.xx - xx` 两段直接拼接（中间**无换行**），此处逐字保留
    `${bot} Bot提醒您：打机时不要大力拍打或滑动哦`,
    `今日推荐歌曲：ID.${song.song_id} - ${song.song_name}`,
  ].join('\n')
}

/**
 * 今日舞萌的随机种子（源 `user.qqid`）
 * 源只认数字 QQ；本仓兼容官方 QQBot 的 openid 用户——无数字 qqid 时用用户键派生一个
 * 稳定的 32 位种子（**超出源的扩展**，保证同一人同一天结果仍稳定，而不是直接报错）
 */
export function fortuneSeed(user) {
  const qq = Number(user?.qqid)
  if (Number.isInteger(qq) && qq > 0) return qq
  let h = 0
  for (const ch of String(user?.key ?? '')) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0
  return Math.abs(h) || 1
}

/**
 * 今日舞萌执行体（带命令头与免前缀两条规则共用；与呈现分离，将来换渲染页只改这里）
 * 源 GetOrCreateSender：auto_create=True（无绑定时自动建行）、allow_at=False（@他人无效）
 */
async function sendFortune(ctx, e) {
  if (!(await ensureReady(e))) return true
  const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
  if (!got) return true

  const data = buildFortune(fortuneSeed(got.user), { list: mai.totalList.root })
  if (!data.song) {
    await ctx.reply('曲库尚未就绪，请稍后再试。', true)
    return true
  }

  const cover = fs.readFileSync(songChartFile(data.song.song_id))
  const levels = data.song.difficulties.map(d => pyFloat(d.level_value)).join('/')
  await ctx.reply(toSegment([fortuneText(data, botName()), cover, levels]), true)
  return true
}

/** #mai fortune / jrrp / 今日舞萌 —— 源 mai_base.py:310-337（D6：宜忌改三分类 4+4） */
export class MaiFortune extends plugin {
  constructor() {
    super({
      name: 'mai-fortune',
      dsc: '舞萌DX今日舞萌',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_FORTUNE().source, fnc: 'fortune' },
      ],
    })
  }

  async fortune(e) {
    return await sendFortune(this, e)
  }
}

/** 免前缀「今日舞萌」（本仓口语规则约定：priority 1500、log:false） */
export class MaiFortuneSay extends plugin {
  constructor() {
    super({
      name: 'mai-fortune-say',
      dsc: '舞萌DX今日舞萌（免前缀）',
      event: 'message',
      priority: 1500,
      rule: [
        { reg: REG_FORTUNE_SAY().source, fnc: 'fortuneSay', log: false },
      ],
    })
  }

  async fortuneSay(e) {
    return await sendFortune(this, e)
  }
}

/** #mai rand <类型><颜色><定数> —— 源 mai_base.py:357-385 的收编形态（设计 §3.2-11） */
export class MaiRand extends plugin {
  constructor() {
    super({
      name: 'mai-rand',
      dsc: '舞萌DX随机谱面',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_RAND().source, fnc: 'randSong' },
      ],
    })
  }

  async randSong(e) {
    if (!(await ensureReady(e))) return true
    const raw = ((e.msg.match(REG_RAND()) || [])[1] || '').trim()
    // 无条件 ⇒ 全曲库随机（与帮助里的 [类型][颜色][定数] 及 phi 的 rand 一致）
    const songs = filterRandSongs(raw)
    if (!songs) {
      await this.reply(
        '随机谱面用法：#mai rand [dx|sd][绿黄红紫白][定数]\n'
        + '例：#mai rand（全曲库随机）、#mai rand dx紫14、#mai rand 13、#mai rand 白13+',
        true,
      )
      return true
    }
    if (!songs.length) {
      await this.reply('没有这样的乐曲哦。', true)
      return true
    }

    // 源用模块级 random.choice（OS 熵，不可复现）；此处保持「每次不同」的同语义
    const song = songs[Math.floor(Math.random() * songs.length)]
    // 源 GetUserAndAuthOrNone：拿不到用户（未绑定/落雪未授权）时 user=None，draw_chart_info 落到 prism_plus
    const got = await getUserAndAuth(e, { autoCreate: true, requireAuth: true, checkSkip: true })
    await this.reply(toSegment(await drawChartInfo(song, got?.user ?? null)), true)
    return true
  }
}

/** 口语「来个/随个/给个 …」—— 源随机谱面的免前缀形态（设计 §3.2 保留清单） */
export class MaiRandSay extends plugin {
  constructor() {
    super({
      name: 'mai-rand-say',
      dsc: '舞萌DX随机谱面（口语）',
      event: 'message',
      priority: 1500,
      rule: [
        { reg: REG_RAND_SAY().source, fnc: 'randSay', log: false },
      ],
    })
  }

  async randSay(e) {
    const m = e.msg.match(REG_RAND_SAY())
    if (!m) return false
    // 口语规则静默降级（同 MaiFun）：未就绪时静默重试一次，失败不回复，不打扰普通聊天
    // ⚠️ 必须**先**确保就绪再筛曲：否则会拿空曲库筛出 []，误报「没有这样的乐曲」
    if (!mai.ready && !(await mai.init().catch(() => false))) return false
    const songs = filterRandSongs(`${m[1] || ''}${m[2] || ''}${m[3] || ''}`)
    if (!songs) return false
    if (!songs.length) {
      await this.reply('没有这样的乐曲哦。', true)
      return true
    }
    const song = songs[Math.floor(Math.random() * songs.length)]
    const got = await getUserAndAuth(e, { autoCreate: true, requireAuth: true, checkSkip: true })
    await this.reply(toSegment(await drawChartInfo(song, got?.user ?? null)), true)
    return true
  }
}

const REG_RISE = () => new RegExp(`^[#/]${H()}\\s*(?:rise|推分)(?:\\s+(\\S+))?(?:\\s+(\\d+))?\\s*$`)
/** 源触发词原文：`我要在?([0-9]+\+?)?[上加\+]([0-9]+)?分\s?(.+)?` */
const REG_RISE_SAY = () => /^我要在?([0-9]+\+?)?[上加\+]([0-9]+)?分\s?(.+)?/

/** 解析等级/分数字面（源 rise_score.handle：score 非 None 才 int()） */
export function parseRiseArgs(levelRaw, scoreRaw) {
  const level = levelRaw || null
  const score = scoreRaw == null || scoreRaw === '' ? null : parseInt(scoreRaw, 10)
  return { level, score }
}

export class MaiRise extends plugin {
  constructor() {
    super({
      name: 'mai-rise',
      dsc: '舞萌DX上分推荐',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_RISE().source, fnc: 'riseScore' },
      ],
    })
  }

  /** #mai rise [等级] [分数] —— 源 mai_base.py:386 rise_score.handle */
  async riseScore(e) {
    if (!(await ensureReady(e))) return true
    const m = e.msg.match(REG_RISE()) || []
    const { level, score } = parseRiseArgs(m[1], m[2])
    if (level && !LEVEL_LIST.includes(level)) {
      await this.reply('无此等级', true)
      return true
    }
    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    const payload = await drawRiseScoreList(got.user, level, score)
    await this.reply(toSegment(payload), true)
    return true
  }
}

/**
 * 口语「我要在13+上1分」 —— 源 rise_score 的免前缀形态（设计 §3.2-12 保留）
 * priority 1500、log:false；未命中语义一律 return false 放行
 */
export class MaiRiseSay extends plugin {
  constructor() {
    super({
      name: 'mai-rise-say',
      dsc: '舞萌DX口语上分推荐',
      event: 'message',
      priority: 1500,
      rule: [
        { reg: REG_RISE_SAY().source, fnc: 'riseSay', log: false },
      ],
    })
  }

  async riseSay(e) {
    const m = e.msg.match(REG_RISE_SAY())
    if (!m) return false
    if (!(await ensureReady(e))) return false
    const { level, score } = parseRiseArgs(m[1], m[2])
    if (level && !LEVEL_LIST.includes(level)) {
      await this.reply('无此等级', true)
      return true
    }
    const got = await getUserAndAuth(e, { requireAuth: true, checkSkip: true, botName: botName() })
    if (!got) return true
    const payload = await drawRiseScoreList(got.user, level, score)
    await this.reply(toSegment(payload), true)
    return true
  }
}

/** 口语「…mai…什么…」随机 / 推分（源 mai_what，设计 §3.2-10，P1 已交付） */
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
