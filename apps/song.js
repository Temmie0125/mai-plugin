/**
 * #mai song 查歌族 + 什么歌反查（源 commands/mai_search.py，设计 §3.2-20/21/22）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * - song：<关键词>（曲名）/ 定数|bpm|曲师|谱师 前缀过滤；1→谱面卡，≤5→文本，>5→分页列表图
 * - what / 「XX是什么歌」：本地别名 → 柚子投票态 → id → 标题链（口语正则保留，priority 1500）
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { getUserAndAuth } from '../lib/user.js'
import { drawChartInfo, drawSongList } from '../lib/handler.js'
import { toSegment, botName } from '../lib/render/picmodle.js'
import { mai, ensureReady } from '../lib/service.js'
import { YuzuChaNAPI } from '../lib/client/yuzuchan.js'
import { awaitPickSong, handlePickSong } from '../lib/pickSong.js'

const H = () => head()

const REG_SONG = () => new RegExp(`^[#/]${H()}\\s+(?:song|查歌)\\s+(.+)$`)
const REG_WHAT = () => new RegExp(`^[#/]${H()}\\s+what\\s+(.+)$`)
const REG_ALIAS = () => new RegExp(`^[#/]${H()}\\s+alias(?:\\s+(.+))?$`)
const REG_WHAT_SAY = () => new RegExp(`^(.+)是(什么|啥)歌[？?]?([0-9]+)?$`)

const isFloat = v => !Number.isNaN(parseFloat(v))

/** 查歌参数解析（源 depend.py process_regex 直译；返回 null 表示参数错误需回复 msg） */
export function parseSongQuery(rawArgs) {
  const tokens = rawArgs.split(/\s+/).filter(Boolean)
  const first = tokens[0]
  const rest = tokens.slice(1)

  let cmd = null
  if (['定数', 'bpm', '曲师', '谱师'].includes(first)) {
    cmd = first
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
      return { result: song ? [song] : [] }
    }
    // 整词别名精确命中 → 直出（源别名仅在「什么歌」通道；此处为查歌族友好化扩展，
    // 仅当标题过滤 0 命中时兜底判断，避免别名歧义干扰正常标题搜索）
    if (list.length === 1) {
      const aliasSongs = mai.totalAliasList.byAlias(list[0])
      if (aliasSongs.length) {
        const songs = aliasSongs
          .map(a => mai.totalList.byId(a.song_id))
          .filter(Boolean)
        return { result: songs }
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
    return { result: mai.totalList.filter({ title }) }
  }

  if (cmd === '定数') {
    let ds1
    let ds2
    if (rest.length === 1 && isFloat(rest[0])) {
      ;[ds1, ds2] = [parseFloat(rest[0]), parseFloat(rest[0])]
    } else if (rest.length === 2 && isFloat(rest[0]) && isFloat(rest[1])) {
      ;[ds1, ds2] = [parseFloat(rest[0]), parseFloat(rest[1])]
    } else if (rest.length === 3 && isFloat(rest[0]) && isFloat(rest[1]) && /^\d+$/.test(rest[2])) {
      ;[ds1, ds2, page] = [parseFloat(rest[0]), parseFloat(rest[1]), parseInt(rest[2], 10)]
    } else {
      return {
        error: [
          '定数查歌参数错误，请输入正确格式，页数为可选：',
          '定数查歌「定数」「页数」',
          '定数查歌「最小定数」「最大定数」「页数」',
          '',
        ].join('\n'),
      }
    }
    return { result: mai.totalList.filter({ level_value: [ds1, ds2] }) }
  }

  if (cmd === 'bpm') {
    let result
    if (rest.length === 1 && isFloat(rest[0])) {
      result = mai.totalList.filter({ bpm: parseFloat(rest[0]) })
    } else if (rest.length === 2 && isFloat(rest[0]) && isFloat(rest[1])) {
      const [b1, b2] = [parseFloat(rest[0]), parseFloat(rest[1])]
      if (b1 > b2) {
        page = Math.trunc(b2)
        result = mai.totalList.filter({ bpm: b1 })
      } else {
        result = mai.totalList.filter({ bpm: [b1, b2] })
      }
    } else if (rest.length === 3 && isFloat(rest[0]) && isFloat(rest[1]) && /^\d+$/.test(rest[2])) {
      result = mai.totalList.filter({ bpm: [parseFloat(rest[0]), parseFloat(rest[1])] })
      page = parseInt(rest[2], 10)
    } else {
      return {
        error: [
          'bpm查歌参数错误，请输入正确格式，页数为可选：',
          'bpm查歌「bpm」「页数」',
          'bpm查歌「最小bpm」「最大bpm」「页数」',
          '',
        ].join('\n'),
      }
    }
    return { result }
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
  return { result }
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
        { reg: `^[#/]${H()}\\s+(?:song|查歌)(?:\\s+(.+))?$`, fnc: 'query' },
        { reg: `^[#/]${H()}\\s+what\\s+(.+)$`, fnc: 'whatIs' },
      ],
    })
  }

  /** #mai song / #mai 查歌 */
  async query(e) {
    if (!(await ensureReady(e))) return true
    const args = ((e.msg.match(REG_SONG()) || [])[1] || '').trim()
    if (!args) {
      await this.reply('没有找到这样的乐曲。\n※ 如果是别名请使用「XXX是什么歌」指令进行查询哦。', true)
      return true
    }
    const parsed = parseSongQuery(args)
    if (parsed.error) {
      await this.reply(parsed.error.trimEnd(), true)
      return true
    }
    const { result, page } = parsed
    const songs = result

    if (!songs.length) {
      await this.reply('没有找到这样的乐曲。\n※ 如果是别名请使用「XXX是什么歌」指令进行查询哦。', true)
      return true
    }

    const got = await getUserAndAuth(e, { requireAuth: true, checkSkip: true, botName: botName() })
    const user = got?.user ?? null

    if (songs.length === 1) {
      const payload = await drawChartInfo(songs[0], user)
      await this.reply(toSegment(payload), true)
    } else if (songs.length <= 5) {
      await this.reply(songs.map(songLine).join('\n'), true)
    } else {
      const image = await drawSongList(songs, page)
      await this.reply(toSegment(image), true)
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
      '※ 可以使用「添加别名」指令给该乐曲添加别名',
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
        msg += '※ 请使用「id xxxxx」查询指定曲目'
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
      msg += '※ 请使用「id xxxxx」查询指定曲目'
      await this.reply(msg, true)
    } else {
      const image = await drawSongList(result, page)
      let msg = `未找到别名为「${name}」的歌曲，但找到「${result.length}」个相似标题的曲目：\n`
      await this.reply([msg, toSegment(image)], true)
    }
    return true
  }

  /** 多候选选曲上下文（§3.4） */
  async pickSong(e) {
    return await handlePickSong(this, e)
  }
}

/**
 * #mai alias <id|曲名|别名> —— 查指定曲目的别名列表（设计 §3.2-44 查询侧）
 * 对齐 phi-plugin `#phi alias <曲名>` 心智：alias 词头后接动作词（sync/local/apply/vote/votes）
 * 属管理/投票路由（P3 实现，本类规则仅注册通配查询，动作词在 fnc 内预留分流）。
 */
export class MaiAlias extends plugin {
  constructor() {
    super({
      name: 'mai-alias',
      dsc: '舞萌DX查别名',
      event: 'message',
      priority: 100,
      rule: [
        { reg: `^[#/]${H()}\\s+alias\\s+(.+)$`, fnc: 'queryAlias' },
      ],
    })
  }

  /** 别名查询入口：id / 曲名精确 / 别名精确 / 标题过滤 解析到目标曲（源查别名链） */
  async queryAlias(e) {
    if (!(await ensureReady(e))) return true
    const raw = ((e.msg.match(REG_ALIAS()) || [])[1] || '').trim()
    if (!raw) {
      await this.reply('用法：#mai alias <曲名|id|别名>\n例：#mai alias 悲怆（查询该别名所属曲目的全部别名）', true)
      return true
    }

    // 动作词预留（P3 管理/投票路由，勿落到通配查询）
    if (['sync', 'local', 'apply', 'vote', 'votes'].includes(raw.split(/\s+/)[0])) {
      await this.reply(`「${raw.split(/\s+/)[0]}」属于别名管理指令，将在后续版本开放。`, true)
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
