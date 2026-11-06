/**
 * 机厅人数（群内互助上报）——管理命令 + 免前缀查询/上报兜底
 *
 * 管理命令带**可选命令头**（`#创建机厅 机厅` 与 `#mai 创建机厅 机厅` 都可用，REG_OPEN 同款
 * 惯用法），群管专用（宿主 `rule.permission`：master 恒放行，群聊内校验群主/群管）。
 * 口语交互（`机厅j` 查询、`机厅3` 上报、`机厅±N` 增减）**免前缀**，与猜歌裸答同构：
 * 兜底类 priority 200、log:false、未命中自身语义一律 `return false` 放行，绝不吞无关聊天
 * （误触发窗口 = 群内有名字/别名恰好被「j|几|数字」后缀命中的机厅，由创建者自己把握）。
 *
 * 数据与校验都在 lib/arcade.js；本文件只做正则提取、文案与回复。
 */
import { MaiPlugin } from '../lib/qqbot.js'
import { head } from '../lib/config.js'
import * as arcade from '../lib/arcade.js'

const H = () => head()

/* 管理命令：`(?:${H()}\s*)?` 让裸 `#创建机厅` 与 `#mai 创建机厅` 都可用；
 * 参数可选化（`(?:\s+(.+))?`）是为了「#创建机厅」缺参时也能回用法，而非静默不响应 */
const REG_CREATE = () => new RegExp(`^[#/](?:${H()}\\s*)?创建机厅(?:\\s+(.+))?\\s*$`)
const REG_REMOVE = () => new RegExp(`^[#/](?:${H()}\\s*)?删除机厅(?:\\s+(.+))?\\s*$`)
const REG_ADD_ALIAS = () => new RegExp(`^[#/](?:${H()}\\s*)?添加机厅别名(?:\\s+(.+))?\\s*$`)
const REG_DEL_ALIAS = () => new RegExp(`^[#/](?:${H()}\\s*)?删除机厅别名(?:\\s+(.+))?\\s*$`)
const REG_LIST = () => new RegExp(`^[#/](?:${H()}\\s*)?机厅列表\\s*$`)
/** 兜底：免前缀匹配一切，仅当解析出机厅语义才消费（priority 200，见 MaiArcadeListen） */
const REG_ANSWER = /^[\s\S]*$/

/** 展示名（上报记录快照用，guess.js 同款） */
const displayName = e => String(e.sender?.card || e.sender?.nickname || e.user_id || '')

const WORD_ERRORS = {
  empty: '名称不能为空',
  'has-arrow': '名称不能包含「->」',
  'too-long': '名称最长 24 个字符',
}

const USAGE = {
  create: '用法：#创建机厅 <名称>，例如 #创建机厅 机厅',
  remove: '用法：#删除机厅 <名称或别名>',
  addAlias: '用法：#添加机厅别名 <机厅名>-><别名>，例如 #添加机厅别名 机厅->jt',
  delAlias: '用法：#删除机厅别名 <机厅名>-><别名>，例如 #删除机厅别名 机厅->jt',
}

/** 按第一个 `->` 切分「名->别名」，两侧 trim；无分隔符返回 null */
function splitArrow(arg) {
  const idx = arg.indexOf('->')
  if (idx < 0) return null
  return [arg.slice(0, idx).trim(), arg.slice(idx + 2).trim()]
}

/** 查询文案（最后上报者 + 绝对时间 + 相对时间；从未上报给示例引导） */
export function queryText(name, row, now = Date.now()) {
  if (row.reporter && row.updatedAt) {
    const abs = arcade.formatAbsolute(row.updatedAt, now)
    const rel = arcade.formatRelative(now, row.updatedAt)
    return `「${name}」${row.count}人\n由「${row.reporter}」更新于：${abs}（${rel}）`
  }
  return `「${name}」${row.count || 0}人\n暂无上报记录（示例：${name}3）`
}

/** 上报文案：绝对/±0 用「修改至」，增减用「增加至/减少至」 */
export function reportText(name, from, to, delta) {
  if (delta == null || delta === 0) return `「${name}」人数由${from}修改至${to}`
  const verb = delta > 0 ? '增加至' : '减少至'
  return `「${name}」人数由${from}${verb}${to}`
}

/** 列表文案（名称/人数/别名；空群给创建引导） */
export function listText(gid) {
  const list = arcade.listArcades(gid)
  if (!list.length) return '本群还没有机厅，管理员可用「#创建机厅 <名称>」创建'
  const lines = list.map(({ name, row }) =>
    `「${name}」${row.count || 0}人${row.aliases?.length ? `（别名：${row.aliases.join('、')}）` : ''}`)
  return `本群机厅（${list.length}）：\n${lines.join('\n')}`
}

/**
 * 机厅管理：#创建机厅 / #删除机厅 / #添加机厅别名 / #删除机厅别名 / #机厅列表（均群管）
 * 失败必回执（重名/不存在/格式错均明确提示，不静默）
 */
export class MaiArcade extends MaiPlugin {
  constructor() {
    super({
      name: 'mai-arcade',
      dsc: '机厅人数管理',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_CREATE().source, fnc: 'createArcade', permission: 'admin' },
        { reg: REG_REMOVE().source, fnc: 'removeArcade', permission: 'admin' },
        { reg: REG_ADD_ALIAS().source, fnc: 'addAlias', permission: 'admin' },
        { reg: REG_DEL_ALIAS().source, fnc: 'removeAlias', permission: 'admin' },
        { reg: REG_LIST().source, fnc: 'listArcades', permission: 'admin' },
      ],
    })
  }

  /** #创建机厅 <名称> */
  async createArcade(e) {
    if (!e.isGroup) {
      await this.reply('创建机厅是群内功能，请在群聊中使用。', true)
      return true
    }
    const arg = (e.msg.match(REG_CREATE()) || [])[1]
    if (!arg?.trim()) {
      await this.reply(USAGE.create, true)
      return true
    }
    const res = arcade.create(e.group_id, arg)
    if (!res.ok) {
      const text = res.reason === 'exists'
        ? `本群已存在同名或同别名的机厅「${res.holder}」`
        : WORD_ERRORS[res.reason]
      await this.reply(text, true)
      return true
    }
    await this.reply(
      `机厅「${res.name}」已创建，发送「${res.name}j」查人数，「${res.name}3」上报人数（支持 ${res.name}±N 增减）`,
      true,
    )
    return true
  }

  /** #删除机厅 <名称|别名> */
  async removeArcade(e) {
    if (!e.isGroup) {
      await this.reply('删除机厅是群内功能，请在群聊中使用。', true)
      return true
    }
    const arg = (e.msg.match(REG_REMOVE()) || [])[1]
    if (!arg?.trim()) {
      await this.reply(USAGE.remove, true)
      return true
    }
    const res = arcade.remove(e.group_id, arg)
    if (!res.ok) {
      await this.reply(`本群没有名为或别名为「${arg.trim()}」的机厅`, true)
      return true
    }
    await this.reply(`已删除机厅「${res.name}」`, true)
    return true
  }

  /** #添加机厅别名 <机厅名>-><别名> */
  async addAlias(e) {
    if (!e.isGroup) {
      await this.reply('机厅别名是群内功能，请在群聊中使用。', true)
      return true
    }
    const arg = (e.msg.match(REG_ADD_ALIAS()) || [])[1]
    const parts = arg?.trim() ? splitArrow(arg) : null
    if (!parts || !parts[0] || !parts[1]) {
      await this.reply(USAGE.addAlias, true)
      return true
    }
    const [name, alias] = parts
    const res = arcade.addAlias(e.group_id, name, alias)
    if (!res.ok) {
      const text = res.reason === 'exists' ? `别名「${alias}」已被机厅「${res.holder}」占用`
        : res.reason === 'not-found' ? `本群没有机厅「${name}」`
          : WORD_ERRORS[res.reason] || USAGE.addAlias
      await this.reply(text, true)
      return true
    }
    await this.reply(`已为「${res.name}」添加别名「${res.alias}」，发送「${res.alias}j」即可查询`, true)
    return true
  }

  /** #删除机厅别名 <机厅名>-><别名> */
  async removeAlias(e) {
    if (!e.isGroup) {
      await this.reply('机厅别名是群内功能，请在群聊中使用。', true)
      return true
    }
    const arg = (e.msg.match(REG_DEL_ALIAS()) || [])[1]
    const parts = arg?.trim() ? splitArrow(arg) : null
    if (!parts || !parts[0] || !parts[1]) {
      await this.reply(USAGE.delAlias, true)
      return true
    }
    const [name, alias] = parts
    const res = arcade.removeAlias(e.group_id, name, alias)
    if (!res.ok) {
      const text = res.reason === 'not-found' ? `本群没有机厅「${name}」`
        : res.reason === 'no-alias' ? `「${name}」没有别名「${alias}」`
          : USAGE.delAlias
      await this.reply(text, true)
      return true
    }
    await this.reply(`已删除「${res.name}」的别名「${res.alias}」`, true)
    return true
  }

  /** #机厅列表 */
  async listArcades(e) {
    if (!e.isGroup) {
      await this.reply('机厅列表是群内功能，请在群聊中使用。', true)
      return true
    }
    await this.reply(listText(e.group_id), true)
    return true
  }
}

/**
 * 口语兜底：机厅j / 机厅几（查询）、机厅3（绝对上报）、机厅±N（增减上报）
 *
 * priority **200**：排在全部主命令之后；未命中自身语义一律 `return false` 放行，
 * 绝不吞无关聊天。本群无机厅时（正则为 null）第一步即放行，几乎零开销。
 */
export class MaiArcadeListen extends MaiPlugin {
  constructor() {
    super({
      name: 'mai-arcade-listen',
      dsc: '机厅人数查询/上报',
      event: 'message',
      priority: 200,
      rule: [
        { reg: REG_ANSWER.source, fnc: 'onMessage', log: false },
      ],
    })
  }

  async onMessage(e) {
    if (!e.isGroup) return false
    const msg = String(e.msg || '').trim()
    if (!msg) return false
    const regex = arcade.buildMatchRegex(e.group_id)
    if (!regex) return false
    const m = msg.match(regex)
    if (!m) return false

    const suffix = m[1]
    const word = msg.slice(0, msg.length - suffix.length)

    // j / 几 后缀 → 查询（正则词表即实时数据，resolve 理论必中，守一手竞态）
    if (suffix === 'j' || suffix === '几') {
      const hit = arcade.resolve(e.group_id, word)
      if (!hit) return false
      await this.reply(queryText(hit.name, hit.row), true)
      return true
    }

    // 纯数字 → 绝对上报；带 ± → 增减上报
    const delta = /^[-+]/.test(suffix) ? parseInt(suffix, 10) : null
    const action = delta == null ? { abs: parseInt(suffix, 10) } : { delta }
    const res = arcade.applyReport(e.group_id, word, action, displayName(e))
    if (res.ok) {
      await this.reply(reportText(res.name, res.from, res.to, delta), true)
      return true
    }
    if (res.reason === 'negative') {
      await this.reply(`「${res.name}」当前仅${res.from}人，无法减少${Math.abs(delta ?? 0)}`, true)
      return true
    }
    return false
  }
}
