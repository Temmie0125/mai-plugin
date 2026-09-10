/**
 * #mai song / search 查歌族 + 什么歌反查（源 commands/mai_search.py，设计 §3.2-20/21/22）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * - song：精确直查 → 曲目详情卡（1 命中）；多条结果自动降级为列表（≤5 文本 / >5 分页图）
 * - search：检索列表语义（对齐 phi-plugin `#phi search` 心智）——跳过详情卡分支，一律列表
 *   两者共享 parseSongQuery：曲名/别名/ID + 定数|bpm|曲师|谱师 前缀过滤
 *   数值语法：`定数14`/`定数14.5`、等级字面 `定数14+`（游戏内 14.6+ 显示「14+」）、
 *   区间必须显式连接符 `定数14-15`/`定数14~15`（含全角 ～/－）、尾部数字为页码；
 *   无连接符的双数字 = 单值 + 页码（如 `定数14 4`，防区间误判）；bpm 语法同构
 * - what / 「XX是什么歌」：本地别名 → 柚子投票态 → id → 标题链（口语正则保留，priority 1500）
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { getUserAndAuth } from '../lib/user.js'
import { drawChartInfo, drawSongList, drawVoteList, sortVotes, hasNumericQq, ALIAS_QQ_HINT } from '../lib/handler.js'
import { toSegment, botName } from '../lib/render/picmodle.js'
import { mai, ensureReady, updateLocalAlias, rebuildAliasFromCache } from '../lib/service.js'
import { YuzuChaNAPI } from '../lib/client/yuzuchan.js'
import { awaitPickSong, handlePickSong } from '../lib/pickSong.js'

const H = () => head()

const REG_SONG = () => new RegExp(`^[#/]${H()}\\s*(?:song|查歌)(?:\\s+(.+))?$`)
const REG_SEARCH = () => new RegExp(`^[#/]${H()}\\s*(?:search|检索|搜索)(?:\\s+(.+))?$`)
const REG_WHAT = () => new RegExp(`^[#/]${H()}\\s*what\\s+(.+)$`)
const REG_ALIAS = () => new RegExp(`^[#/]${H()}\\s*alias(?:\\s+(.+))?$`)
// 别名动作词（设计 §3.2 表下注：**动作词规则声明在前、通配查询殿后**，同 priority 先命中先服务）
const REG_ALIAS_SYNC = () => new RegExp(`^[#/]${H()}\\s*(?:alias\\s+sync|更新别名库)\\s*$`)
const REG_ALIAS_LOCAL = () => new RegExp(`^[#/]${H()}\\s*(?:alias\\s+local|本地别名)\\s+(.+)$`)
const REG_ALIAS_APPLY = () => new RegExp(`^[#/]${H()}\\s*(?:alias\\s+apply|申请别名)\\s+(.+)$`)
// tag 可缺（源同样照发空串），故参数可选——否则 `#mai alias vote` 会掉进通配查询分支。
// 另收 `#mai vote …` 短写（投票时顺手，无需带 alias 词头；与 `alias votes` 不冲突，已由测试锁定）
const REG_ALIAS_VOTE = () => new RegExp(`^[#/]${H()}\\s*(?:alias\\s+vote|同意别名|vote)(?:\\s+(.+))?\\s*$`)
const REG_ALIAS_VOTES = () => new RegExp(`^[#/]${H()}\\s*(?:alias\\s+votes|当前投票)(?:\\s+(.+))?\\s*$`)
const REG_WHAT_SAY = () => new RegExp(`^(.+)是(什么|啥)歌[？?]?([0-9]+)?$`)

const isFloat = v => !Number.isNaN(parseFloat(v))

/**
 * 查歌参数解析（源 depend.py process_regex 语义 + 收编后的粘连前缀扩展）
 * - 源触发形态「定数14查歌」中前缀紧贴触发词；收编为子命令后支持 `#mai song 定数14`
 *   与 `#mai song 定数 14` 两种写法（前缀后空格可选）
 */
export function parseSongQuery(rawArgs) {
  const raw = String(rawArgs).trim()
  const lead = raw.match(/^(定数|bpm|曲师|谱师)\s*(.+)$/i)
  const tokens = raw.split(/\s+/).filter(Boolean)

  let cmd = null
  let rest = []
  if (lead) {
    cmd = lead[1].toLowerCase() === 'bpm' ? 'bpm' : lead[1]
    rest = lead[2].split(/\s+/).filter(Boolean)
  }

  let page = 1
  if (cmd == null) {
    const list = tokens
    if (!list.length) {
      return { error: '没有找到这样的乐曲。\n※ 如果是别名请使用「XXX是什么歌」指令进行查询哦。' }
    }
    // 纯数字 / `id xxxx` → 曲库 id 直查（源「id xxxxx」语义收编，设计 §3.2-22）
    const idOnly = /^\d+$/.test(list.join(''))
    const idPrefixed = list.length === 2 && list[0].toLowerCase() === 'id' && /^\d+$/.test(list[1])
    if (idOnly || idPrefixed) {
      const num = parseInt(idOnly ? list.join('') : list[1], 10)
      const song = mai.totalList.byId(num)
      return { result: song ? [song] : [], page, source: 'id' }
    }
    // 整词别名精确命中 → 直出（源别名仅在「什么歌」通道；此处为查歌族友好化扩展，
    // 仅当标题过滤 0 命中时兜底判断，避免别名歧义干扰正常标题搜索）
    if (list.length === 1) {
      const aliasSongs = mai.totalAliasList.byAlias(list[0])
      if (aliasSongs.length) {
        const songs = aliasSongs
          .map(a => mai.totalList.byId(a.song_id))
          .filter(Boolean)
        return { result: songs, page, source: 'alias' }
      }
    }
    // 末尾纯数字视为页数，其余整体作为标题（支持含空格的标题）
    let title
    if (list.length >= 2 && /^\d+$/.test(list[list.length - 1])) {
      title = list.slice(0, -1).join(' ')
      page = parseInt(list[list.length - 1], 10)
    } else {
      title = list.join(' ')
    }
    return { result: mai.totalList.filter({ title }), page, source: 'title' }
  }

  // 定数 / bpm：区间必须显式连接符（- 或 ~，含全角 ～/－）；无连接符双数字 = 单值 + 页码
  if (cmd === '定数') {
    const s = rest.join(' ')
    // 定数+（游戏内 14.6+ 显示为「14+」，按等级字面过滤）
    const plus = s.match(/^(\d+)\+(?:\s+(\d+))?$/)
    if (plus) {
      if (plus[2]) page = parseInt(plus[2], 10)
      return { result: mai.totalList.filter({ level: [`${plus[1]}+`] }), page, source: 'filter' }
    }
    const range = s.match(/^(\d+(?:\.\d+)?)\s*[-~～－]\s*(\d+(?:\.\d+)?)(?:\s+(\d+))?$/)
    if (range) {
      const [a, b] = [parseFloat(range[1]), parseFloat(range[2])].sort((x, y) => x - y)
      if (range[3]) page = parseInt(range[3], 10)
      return { result: mai.totalList.filter({ level_value: [a, b] }), page, source: 'filter' }
    }
    const single = s.match(/^(\d+(?:\.\d+)?)(?:\s+(\d+))?$/)
    if (single) {
      if (single[2]) page = parseInt(single[2], 10)
      const v = parseFloat(single[1])
      return { result: mai.totalList.filter({ level_value: [v, v] }), page, source: 'filter' }
    }
    return {
      error: [
        '定数查歌参数错误，页数为可选：',
        '定数查歌「定数或定数+」「页数」（如 定数14、定数14+、定数14 3）',
        '定数查歌「最小定数-最大定数」「页数」（连接符 - 或 ~，如 定数14-15、定数14.5~15 2）',
        '',
      ].join('\n'),
    }
  }

  if (cmd === 'bpm') {
    const s = rest.join(' ')
    const range = s.match(/^(\d+(?:\.\d+)?)\s*[-~～－]\s*(\d+(?:\.\d+)?)(?:\s+(\d+))?$/)
    if (range) {
      const [a, b] = [parseFloat(range[1]), parseFloat(range[2])].sort((x, y) => x - y)
      if (range[3]) page = parseInt(range[3], 10)
      return { result: mai.totalList.filter({ bpm: [a, b] }), page, source: 'filter' }
    }
    const single = s.match(/^(\d+(?:\.\d+)?)(?:\s+(\d+))?$/)
    if (single) {
      if (single[2]) page = parseInt(single[2], 10)
      return { result: mai.totalList.filter({ bpm: parseFloat(single[1]) }), page, source: 'filter' }
    }
    return {
      error: [
        'bpm查歌参数错误，页数为可选：',
        'bpm查歌「bpm」「页数」（如 bpm200、bpm200 3）',
        'bpm查歌「最小bpm-最大bpm」「页数」（连接符 - 或 ~，如 bpm200-300、bpm180~200 2）',
        '',
      ].join('\n'),
    }
  }

  // 曲师 / 谱师
  if (!rest.length) {
    return {
      error: [
        `${cmd}查歌参数错误，请输入正确格式，页数为可选：`,
        `${cmd}查歌「${cmd}」「页数」`,
        '',
      ].join('\n'),
    }
  }
  let name
  if (rest.length >= 2 && /^\d+$/.test(rest[rest.length - 1])) {
    name = rest.slice(0, -1).join(' ')
    page = parseInt(rest[rest.length - 1], 10)
  } else {
    name = rest.join(' ')
  }
  const result = cmd === '曲师'
    ? mai.totalList.filter({ artist: name })
    : mai.totalList.filter({ charter: name, all_diff: false })
  return { result, page, source: 'filter' }
}

/** 单曲文本行（源 `f"「{id}」":<7` 语义） */
function songLine(song) {
  return `「${song.song_id}」`.padEnd(7) + ' ' + song.song_name
}

export class MaiSong extends plugin {
  constructor() {
    super({
      name: 'mai-song',
      dsc: '舞萌DX查歌',
      event: 'message',
      priority: 100,
      rule: [
        { reg: `^[#/]${H()}\\s*(?:song|查歌)(?:\\s+(.+))?$`, fnc: 'query' },
        { reg: `^[#/]${H()}\\s*(?:search|检索|搜索)(?:\\s+(.+))?$`, fnc: 'search' },
        { reg: `^[#/]${H()}\\s*what\\s+(.+)$`, fnc: 'whatIs' },
      ],
    })
  }

  /** #mai song / #mai 查歌：精确直查详情卡；多条自动降级列表 */
  async query(e) {
    return await this.runQuery(e, { forceList: false })
  }

  /** #mai search / #mai 检索：跳过详情卡，一律列表（对齐 phi-plugin `#phi search` 心智） */
  async search(e) {
    return await this.runQuery(e, { forceList: true })
  }

  async runQuery(e, { forceList }) {
    if (!(await ensureReady(e))) return true
    const reg = forceList ? REG_SEARCH() : REG_SONG()
    const args = ((e.msg.match(reg) || [])[1] || '').trim()
    if (!args) {
      await this.reply(
        forceList ? '请输入检索关键词（曲名/别名/定数/bpm/曲师/谱师）' : '没有找到这样的乐曲。\n※ 如果是别名请使用「XXX是什么歌」指令进行查询哦。',
        true,
      )
      return true
    }
    const parsed = parseSongQuery(args)
    if (parsed.error) {
      await this.reply(parsed.error.trimEnd(), true)
      return true
    }
    const { result, page, source } = parsed
    const songs = result

    if (!songs.length) {
      await this.reply('没有找到这样的乐曲。\n※ 如果是别名请使用「XXX是什么歌」指令进行查询哦。', true)
      return true
    }

    const got = await getUserAndAuth(e, { requireAuth: true, checkSkip: true, botName: botName() })
    const user = got?.user ?? null

    // 别名来源多命中：按「什么歌」通道同款给提示头 + id 精确查询指引（源查歌通道无头，
    // 但别名直查是本插件友好化扩展，多曲时需要说明来源与下一步）
    const aliasHeader = source === 'alias' && songs.length > 1
      ? `找到 ${songs.length} 个相同别名的曲目：`
      : null
    const idHint = aliasHeader ? '※ 发送「#mai song <ID>」可直接查询指定曲目' : null

    if (!forceList && songs.length === 1) {
      const payload = await drawChartInfo(songs[0], user)
      await this.reply(toSegment(payload), true)
    } else if (songs.length <= 5) {
      const body = songs.map(songLine).join('\n')
      await this.reply(aliasHeader ? [aliasHeader, body, idHint].join('\n') : body, true)
    } else {
      const image = await drawSongList(songs, page)
      await this.reply(aliasHeader ? [aliasHeader, toSegment(image), idHint] : toSegment(image), true)
    }
    return true
  }

  /** #mai what / XX是什么歌（别名反查链，源 search_alias_song） */
  async whatIs(e) {
    if (!(await ensureReady(e))) return true
    const say = e.msg.match(REG_WHAT_SAY())
    const isSay = Boolean(say)
    const match = isSay ? say : e.msg.match(REG_WHAT())
    if (!match) return false

    const name = match[1].trim()
    const page = isSay ? parseInt(match[3] || '1', 10) : 1
    const errorMsg = [
      `未找到别名为「${name}」的歌曲`,
      '※ 发送「#mai alias apply <ID> <别名>」可申请添加（投票功能将在后续版本开放）',
      '※ 如果是歌名的一部分，请使用「查歌」指令查询哦。',
    ].join('\n')

    const got = await getUserAndAuth(e, { requireAuth: true, checkSkip: true, botName: botName() })
    const user = got?.user ?? null

    // 别名
    let aliasData = mai.totalAliasList.byAlias(name)
    if (!aliasData.length) {
      try {
        const obj = await new YuzuChaNAPI().getSongs(name)
        if (obj && obj.type === 'ongoing' && Array.isArray(obj.data) && obj.data[0]?.tag !== undefined) {
          let msg = `未找到别名为「${name}」的歌曲，但找到与此相同别名的投票：\n`
          for (const s of obj.data) {
            msg += `- ${s.tag}\n    ID ${s.song_id}: ${s.name}\n`
          }
          msg += '※ 可以使用指令「同意别名 XXXXX」进行投票'
          await this.reply(msg.trim(), true)
          return true
        }
        if (Array.isArray(obj?.data)) {
          aliasData = obj.data.map(a => ({ song_id: a.song_id, song_name: a.name, alias: a.alias }))
        }
      } catch { /* 网络失败按未找到处理 */ }
    }

    if (aliasData.length) {
      if (aliasData.length !== 1) {
        let msg = `找到${aliasData.length}个相同别名的曲目：\n`
        for (const song of aliasData) {
          msg += `${song.song_id}：${song.song_name}\n`
        }
        msg += '※ 发送「#mai song <ID>」可直接按曲目 ID 查询'
        await this.reply(msg.trim(), true)
        return true
      }
      const song = mai.totalList.byId(aliasData[0].song_id)
      if (song) {
        const payload = await drawChartInfo(song, user)
        const first = typeof payload === 'string' ? payload : toSegment(payload)
        const arr = Array.isArray(first) ? first : [first]
        await this.reply(['您要找的是不是：', ...arr], true)
      } else {
        await this.reply(errorMsg, true)
      }
      return true
    }

    // id
    if (/^\d+$/.test(name)) {
      const song = mai.totalList.byId(parseInt(name, 10))
      if (song) {
        const payload = await drawChartInfo(song, user)
        const first = typeof payload === 'string' ? payload : toSegment(payload)
        await this.reply(['您要找的是不是：', ...(Array.isArray(first) ? first : [first])], true)
        return true
      }
    }
    const idMatch = name.match(/^id(\d+)$/i)
    if (idMatch) {
      const song = mai.totalList.byId(parseInt(idMatch[1], 10))
      if (!song) {
        await this.reply(`未找到ID「${idMatch[1]}」的乐曲`, true)
        return true
      }
      const payload = await drawChartInfo(song, user)
      const first = typeof payload === 'string' ? payload : toSegment(payload)
      await this.reply(['您要找的是不是：', ...(Array.isArray(first) ? first : [first])], true)
      return true
    }

    // 标题
    const result = mai.totalList.filter({ title: name })
    if (result.length === 0) {
      await this.reply(errorMsg, true)
    } else if (result.length === 1) {
      const payload = await drawChartInfo(result[0], user)
      const first = typeof payload === 'string' ? payload : toSegment(payload)
      await this.reply(['您要找的是不是：', ...(Array.isArray(first) ? first : [first])], true)
    } else if (result.length <= 5) {
      let msg = `未找到别名为「${name}」的歌曲，但找到「${result.length}」个相似标题的曲目：\n`
      for (const song of [...result].sort((a, b) => a.song_id - b.song_id)) {
        msg += `${songLine(song)}\n`
      }
      msg += '※ 发送「#mai song <ID>」可直接按曲目 ID 查询'
      await this.reply(msg, true)
    } else {
      const image = await drawSongList(result, page)
      let msg = `未找到别名为「${name}」的歌曲，但找到「${result.length}」个相似标题的曲目：\n`
      await this.reply([msg, toSegment(image)], true)
    }
    return true
  }

  /** 多候选选曲上下文（§3.4） */
  async pickSong() {
    return await handlePickSong(this)
  }
}

/** 别名列表里是否已有该项（大小写不敏感；服务端存在含大写的别名，源只 lower 了查询侧会漏判） */
const hasAlias = (list, name) => list.some(a => String(a).toLowerCase() === String(name).toLowerCase())

/** 取动作词规则捕获的参数并按空白切分（源 commands 用 `extract_plain_text().split()`） */
function aliasArgs(e, reg) {
  return ((e.msg.match(reg) || [])[1] || '').trim().split(/\s+/).filter(Boolean)
}

/**
 * #mai alias 族（设计 §3.2-37..44）
 *
 * `alias` 词头双义（对齐 phi-plugin 先例）：后接动作词 `sync/local/apply/vote/votes`
 * 走管理/投票路由，否则整段按曲名查别名。消歧靠**规则声明顺序**——动作词五条在前、
 * 通配查询殿后，同 priority 先命中先服务（禁复杂负向前瞻）。
 * 本仓 `apps/table.js` 同样依赖顺序，`tests/tableRules.test.js` 有「规则表顺序」测试锁着。
 */
export class MaiAlias extends plugin {
  constructor() {
    super({
      name: 'mai-alias',
      dsc: '舞萌DX查别名',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_ALIAS_SYNC().source, fnc: 'syncAlias', permission: 'master' },
        { reg: REG_ALIAS_LOCAL().source, fnc: 'addLocal' },
        { reg: REG_ALIAS_APPLY().source, fnc: 'applyAlias' },
        { reg: REG_ALIAS_VOTE().source, fnc: 'voteAlias' },
        { reg: REG_ALIAS_VOTES().source, fnc: 'listVotes' },
        // ⚠️ 通配查询必须殿后，否则会吃掉上面五条动作词
        { reg: REG_ALIAS().source, fnc: 'queryAlias' },
      ],
    })
  }

  /** #mai alias sync / 更新别名库 —— 手动更新别名库（仅主人，源 mai_alias.py:40-48） */
  async syncAlias(e) {
    if (!(await ensureReady(e))) return true
    try {
      await mai.getMusicAlias()
      logger?.mark?.('手动更新别名库成功')
      await this.reply('手动更新别名库成功', true)
    } catch (error) {
      logger?.error?.('手动更新别名库失败', error?.message || error)
      await this.reply('手动更新别名库失败', true)
    }
    return true
  }

  /** #mai alias local <id> <别名> / 本地别名 —— 添加本地别名（源 mai_alias.py:51-81，校验顺序逐字照搬） */
  async addLocal(e) {
    if (!(await ensureReady(e))) return true
    const args = aliasArgs(e, REG_ALIAS_LOCAL())
    if (args.length !== 2) {
      await this.reply('参数错误', true)
      return true
    }
    const [idRaw, aliasName] = args
    if (!/^\d+$/.test(idRaw)) {
      await this.reply('请输入正确的ID', true)
      return true
    }
    const songId = parseInt(idRaw, 10)
    if (!mai.totalList.byId(songId)) {
      await this.reply(`未找到ID「${songId}」的曲目`, true)
      return true
    }

    // 服务器已存在同名别名则拒绝。源此处不做异常保护（网络抖动会直接失败），
    // 端口改为失败即跳过该前置校验——后续合并本就是「柚子优先」去重，跳过无副作用。
    //
    // 比较用**大小写不敏感**：源写的是 `alias_name.lower() in server_exist.alias`，
    // 只在服务端别名本身是小写时才成立（实测 2117 个含拉丁字母的别名里有 14 个含大写，
    // 如 `2B`/`OW`/`TwisteD！XD`），那 14 个会让源的校验漏判。这里两侧都归一。
    let serverAlias = null
    try {
      serverAlias = await new YuzuChaNAPI().getAliasesBySongId(songId)
    } catch { /* 跳过前置校验 */ }
    if (serverAlias && Array.isArray(serverAlias.alias) && hasAlias(serverAlias.alias, aliasName)) {
      await this.reply(`该曲目的别名「${aliasName}」已存在别名服务器`, true)
      return true
    }

    const local = mai.totalAliasList.byId(songId)
    if (local.length && hasAlias(local[0].alias, aliasName)) {
      await this.reply('本地别名库已存在该别名', true)
      return true
    }

    if (!updateLocalAlias(songId, aliasName)) {
      await this.reply('添加本地别名失败', true)
      return true
    }
    // 「加完即生效」：源写完只改内存、要等下次更新才落进合并库；
    // 这里就地用缓存重建（缓存缺失——首次安装尚未同步——才联网兜底）
    if (!rebuildAliasFromCache()) {
      try {
        await mai.getMusicAlias()
      } catch { /* 网络不可用也无妨：内存态已生效，下次同步自会合并 */ }
    }
    await this.reply(`已成功为ID「${songId}」添加别名「${aliasName}」到本地别名库`, true)
    return true
  }

  /** #mai alias apply <id> <别名> / 申请别名 —— 向柚子提交申请表（源 mai_alias.py:84-109，群聊） */
  async applyAlias(e) {
    if (!(await ensureReady(e))) return true
    const args = aliasArgs(e, REG_ALIAS_APPLY())
    if (args.length < 2) {
      await this.reply('参数错误', true)
      return true
    }
    const [idRaw, ...rest] = args
    if (!/^\d+$/.test(idRaw)) {
      await this.reply('请输入正确的ID', true)
      return true
    }
    const aliasName = rest.join(' ') // 源 `" ".join(args[1:])`
    if (!mai.totalList.byId(parseInt(idRaw, 10))) {
      await this.reply(`未找到ID「${idRaw}」的曲目`, true)
      return true
    }
    if (!e.isGroup) {
      await this.reply('别名申请需在群聊中发起（源限制为群消息事件）。', true)
      return true
    }
    // 服务端把 apply_uid 当整数 QQ 校验（源在 OneBot 下 e.user_id 就是 QQ 号；
    // 本仓官方 QQBot 环境是 openid，直发会 422 int_parsing）⇒ 走 #mai bind qq 补充的数字 QQ
    const uid = await this.numericQq(e)
    if (uid == null) return true

    const api = new YuzuChaNAPI()
    let exist
    try {
      exist = await api.getAliasesBySongId(idRaw)
    } catch (error) {
      await this.reply(String(error?.message || error), true)
      return true
    }
    if (exist && Array.isArray(exist.alias) && exist.alias.includes(aliasName.toLowerCase())) {
      await this.reply(`该曲目的别名「${aliasName}」已存在别名服务器`, true)
      return true
    }

    // song_id 源侧就是字符串，照传；回复文案完全由服务端下发（源 finish(result.message)）
    const result = await api.postAlias(idRaw, aliasName, uid, e.group_id)
    await this.reply(result?.message ?? String(result), true)
    return true
  }

  /**
   * 取用于别名申请/投票的**数字 QQ**（不可用时已回复引导并返回 null）
   * 源在 OneBot 下 `e.user_id` 即 QQ 号；本仓兼容 openid 环境，故统一走用户行的 qqid。
   */
  async numericQq(e) {
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
    if (!got) return null
    if (!hasNumericQq(got.user)) {
      await this.reply(ALIAS_QQ_HINT, true)
      return null
    }
    return got.user.qqid
  }

  /**
   * #mai alias vote <tag|#N> / 同意别名 / #mai vote —— 给进行中的申请投同意票
   * （源 mai_alias.py:112-122）
   *
   * `#N` 取自 `#mai alias votes` 图上的**全局编号**，在这里按同一排序口径换回真实 tag ——
   * 于是 `#mai alias vote #1` 与 `#mai alias vote <某串乱码 tag>` 等效，用户不必抄那串标签。
   */
  async voteAlias(e) {
    if (!(await ensureReady(e))) return true
    const raw = ((e.msg.match(REG_ALIAS_VOTE()) || [])[1] || '').trim()

    // 同 applyAlias：服务端按整数 QQ 校验 agree_user
    const uid = await this.numericQq(e)
    if (uid == null) return true

    let tag = raw.toUpperCase()
    const byIndex = tag.match(/^#(\d+)$/)
    if (byIndex) {
      let list
      try {
        list = sortVotes(await new YuzuChaNAPI().getStatus())
      } catch (error) {
        await this.reply(String(error?.message || error), true)
        return true
      }
      const picked = list[parseInt(byIndex[1], 10) - 1]
      if (!picked) {
        await this.reply(
          `没有编号 ${byIndex[1]} 的投票（当前共 ${list.length} 条）。\n`
          + '先发送「#mai alias votes」查看带编号的投票列表。',
          true,
        )
        return true
      }
      tag = String(picked.tag).toUpperCase()
    }

    let msg
    try {
      const status = await new YuzuChaNAPI().postAgreeUser(tag, uid)
      msg = status?.message ?? String(status)
    } catch (error) {
      logger?.error?.('[mai-plugin] 同意别名失败：', error?.message || error)
      msg = String(error?.message || error)
    }
    await this.reply(msg, true)
    return true
  }

  /**
   * #mai alias votes [页] / 当前投票 —— 进行中的别名投票列表（源 mai_alias.py:125-155）
   * 源走 text_to_bytes_io 转图；端口沿用出图形态（投票行带曲绘/版本图标，比转发文本可读），
   * 版式复用曲目列表，信息区换成投票字段（见 lib/render/views.js:voteListView）。
   */
  async listVotes(e) {
    if (!(await ensureReady(e))) return true
    const raw = ((e.msg.match(REG_ALIAS_VOTES()) || [])[1] || '').trim()
    let status
    try {
      status = await new YuzuChaNAPI().getStatus()
    } catch (error) {
      await this.reply(String(error?.message || error), true)
      return true
    }
    if (!Array.isArray(status) || !status.length) {
      await this.reply('未查询到正在进行的别名投票', true)
      return true
    }

    const page = /^\d+$/.test(raw) ? parseInt(raw, 10) : 1
    const image = await drawVoteList(sortVotes(status), page)
    if (typeof image === 'string') {
      await this.reply(image, true)
      return true
    }
    await this.reply(toSegment(image), true)
    return true
  }

  /** 别名查询入口：id / 曲名精确 / 别名精确 / 标题过滤 解析到目标曲（源查别名链） */
  async queryAlias(e) {
    if (!(await ensureReady(e))) return true
    const raw = ((e.msg.match(REG_ALIAS()) || [])[1] || '').trim()
    if (!raw) {
      await this.reply('用法：#mai alias <曲名|id|别名>\n例：#mai alias 悲怆（查询该别名所属曲目的全部别名）', true)
      return true
    }

    const songs = resolveAliasTargets(raw)
    if (!songs.length) {
      await this.reply(
        `未找到「${raw}」对应的曲目或别名。\n※ 可尝试 #mai what ${raw} 或 #mai song ${raw} 查找该曲。`,
        true,
      )
      return true
    }

    // 目标唯一 → 直接展示该曲全部别名；多候选 → 逐首附别名（上限 3 首防刷屏）
    const lines = []
    for (const song of songs.slice(0, 3)) {
      const row = mai.totalAliasList.byId(song.song_id)[0]
      lines.push(`「${song.song_id}」${song.song_name}`)
      if (row?.alias?.length) {
        lines.push(`  别名：${row.alias.join('、')}`)
      } else {
        lines.push('  （该曲目暂无收录别名）')
      }
    }
    if (songs.length > 3) {
      lines.push(`…共 ${songs.length} 首匹配，请用 id 指定曲目查询`)
    }
    await this.reply(lines.join('\n'), true)
    return true
  }
}

/** 解析别名查询目标（供 queryAlias 使用；纯 id → 曲名精确 → 别名精确 → 标题包含） */
export function resolveAliasTargets(raw) {
  const totalList = mai.totalList
  // 1) 纯数字 / id xxxx → id 直查
  if (/^\d+$/.test(raw)) {
    const song = totalList.byId(parseInt(raw, 10))
    return song ? [song] : []
  }
  const idPrefixed = raw.match(/^id\s*(\d+)$/i)
  if (idPrefixed) {
    const song = totalList.byId(parseInt(idPrefixed[1], 10))
    return song ? [song] : []
  }
  // 2) 曲名精确
  const byName = totalList.byName(raw)
  if (byName) return [byName]
  // 3) 别名精确（可能一对多 → 全部返回）
  const aliasRows = mai.totalAliasList.byAlias(raw)
  if (aliasRows.length) {
    const songs = aliasRows.map(a => totalList.byId(a.song_id)).filter(Boolean)
    if (songs.length) return songs
  }
  // 4) 标题包含
  return totalList.filter({ title: raw }).slice(0, 10)
}

/** 口语「XX是什么歌」（无命令头，priority 1500 后置；命中处理后 return false 放行，源非阻塞语义） */
export class MaiSongSay extends plugin {
  constructor() {
    super({
      name: 'mai-song-say',
      dsc: '舞萌DX口语反查',
      event: 'message',
      priority: 1500,
      rule: [
        { reg: '^(.+)是(什么|啥)歌[？?]?([0-9]+)?$', fnc: 'whatIs', log: false },
      ],
    })
  }

  async whatIs(e) {
    // 口语规则静默降级：未就绪时静默重试一次，失败不回复（不打扰普通聊天）
    if (!mai.ready && !(await mai.init().catch(() => false))) return false
    // 原型委托复用 MaiSong.whatIs（this = MaiSongSay 实例，reply 同样继承宿主 plugin 基类）——
    // 不 new MaiSong(e)：宿主 plugin 子类每次消息现构造有副作用/异常风险（真机静默故障源）
    return MaiSong.prototype.whatIs.call(this, e)
  }
}
