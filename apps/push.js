/**
 * #mai push on|off（群管）/ #mai push global on|off（主人）—— 别名推送群开关
 * （设计 §3.2-42/43，P3 实施文档 §9）
 *
 * ⚠️ 刻意偏离源（D4）：源的 aliasPush 是**黑名单**——`AliasesPush{enable,disable}` 双列表，
 * 广播时只读 `disable`，于是「未设置的群」默认为开启；而本插件统一改为**白名单、默认关闭**。
 * 理由：默认开启会让所有未配置的群无端收到推送，对部署者与群成员都是打扰。
 *
 * 白名单带来的简化：群设置只需单一布尔，而 `lib/database.js:getGroup` 的默认值
 * `{ guess:false, aliasPush:false }` 正好就是目标语义 ⇒ **DB 层零改动**（只加了个批量写）。
 *
 * 权限走宿主 `rule.permission`（`lib/plugins/loader.js:filtPermission`）：master 恒放行，
 * 群聊内再校验 `e.member.is_owner/is_admin`。
 */
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { updateGroup, updateGroups } from '../lib/database.js'

const logger = global.logger || console

const H = () => head()

const REG_PUSH_GROUP = () => new RegExp(`^[#/]${H()}\\s*push\\s+(on|off)\\s*$`)
const REG_PUSH_GLOBAL = () => new RegExp(`^[#/]${H()}\\s*push\\s+global\\s+(on|off)\\s*$`)

/**
 * 取「所有已登录账号所在群」的并集（P3 实施文档 §9.2）
 *
 * 宿主有两个同名但不同义的 getGroupList，别用错：
 * - 适配器挂在 `Bot[uin]` 上的 `getGroupList()`：**异步实取**（`plugins/adapter/OneBotv11.js:928,983`），权威
 * - 宿主 `Bot.getGroupList()` / `Bot.bots[uin].gl`：**同步读缓存**，只含「本进程产生过群事件」的群，
 *   重启后可能严重不全 ⇒ 不适合做全局置位的数据源
 * 故优先实取、失败或适配器未实现时退回缓存。多账号取并集——推送按群发，只取单账号会漏群。
 *
 * @param {any} bot 宿主全局 Bot（参数注入，便于单测用假对象）
 * @returns {Promise<Array<number|string>>}
 */
export async function getAllGroups(bot) {
  const ids = new Set()
  const uins = Array.isArray(bot?.uin) ? [...bot.uin] : []
  const fromCache = uin => {
    for (const gid of bot?.bots?.[uin]?.gl?.keys() ?? []) ids.add(gid)
  }

  for (const uin of uins) {
    try {
      const adapterBot = bot[uin]
      if (typeof adapterBot?.getGroupList === 'function') {
        for (const gid of await adapterBot.getGroupList()) ids.add(gid)
      } else {
        fromCache(uin)
      }
    } catch (error) {
      logger.error(`[mai-plugin] 取账号 ${uin} 的群列表失败：${error?.message || error}`)
      // 单账号失败不影响其余；退回该账号的缓存（可能不全，但好过完全没有）
      try { fromCache(uin) } catch { /* 缓存结构异常则放弃该账号 */ }
    }
  }
  return [...ids]
}

export class MaiPush extends plugin {
  constructor() {
    super({
      name: 'mai-push',
      dsc: '舞萌DX别名推送开关',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_PUSH_GROUP().source, fnc: 'pushGroup', permission: 'admin' },
        { reg: REG_PUSH_GLOBAL().source, fnc: 'pushGlobal', permission: 'master' },
      ],
    })
  }

  /** #mai push on|off —— 开关本群别名推送（群管） */
  async pushGroup(e) {
    if (!e.isGroup) {
      await this.reply('该指令用于开关「本群」的别名推送，请在群聊中使用。', true)
      return true
    }
    const on = (e.msg.match(REG_PUSH_GROUP()) || [])[1] === 'on'
    updateGroup(e.group_id, { aliasPush: on })
    await this.reply(on ? '群别名推送功能已开启' : '群别名推送功能已关闭', true)
    // P3e 接缝：白名单由空变非空/由非空变空时要重估 SSE 建连（文档 §9.3）
    return true
  }

  /** #mai push global on|off —— 全部群批量置位（主人） */
  async pushGlobal(e) {
    const on = (e.msg.match(REG_PUSH_GLOBAL()) || [])[1] === 'on'
    const groups = await getAllGroups(globalThis.Bot)

    // 取不到群列表时**必须**明确回执：管理员以为已全局开启而实际一个群都没置位，是最难排查的状态
    if (!groups.length) {
      await this.reply(
        '未能取到任何群列表（当前适配器可能未实现 getGroupList）。\n'
        + '请改用群内「#mai push on」逐群开启。',
        true,
      )
      return true
    }

    updateGroups(Object.fromEntries(groups.map(gid => [gid, { aliasPush: on }])))
    await this.reply(
      `${on ? '已全局开启' : '已全局关闭'}maimai别名推送（共 ${groups.length} 个群）`,
      true,
    )
    return true
  }
}
