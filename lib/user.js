/**
 * 用户解析（源 commands/depend.py GetUserModel 五变体 → 参数化单函数，设计 §4.4）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * - 用户键双协议兼容：OneBot=纯数字 QQ；官方 QQBot=openid（原样字符串，不强转数字）
 * - allowAt：取宿主 loader 算好的 `e.at` 作代查目标（loader 已排除 bot 自身；仅纯数字有效，
 *   过滤 at-all 与官方环境的 openid 形态）
 * - autoCreate：无记录时创建默认（service=df, theme=prism_plus）
 * - requireAuth + checkSkip：落雪源无凭据时的引导/静默降级
 */
import * as database from './database.js'
import { authorizeError } from './handlerError.js'

/**
 * @param {object} e 宿主事件
 * @param {{autoCreate?: boolean, requireAuth?: boolean, checkSkip?: boolean, allowAt?: boolean, botName?: string}} opts
 * @returns {Promise<{user: object, targetQq: string}|null>} 失败时已内部回复，调用方 return true
 */
export async function getUserAndAuth(e, {
  autoCreate = true,
  requireAuth = false,
  checkSkip = false,
  allowAt = true,
  botName = 'Maimai',
} = {}) {
  // 用户键：@代查目标优先 → 否则 e.user_id 原样（数字 QQ 或 openid 均可作键）
  // ⚠️ @目标必须取宿主 loader（lib/plugins/loader.js dealEvent）算好的 `e.at`——
  // 它对 at 段已按 `i.qq == e.self_id` 排除 **bot 自身**（at-bot 只置 e.atBot）。
  // 之前直接重扫 e.message 原始数组，官方 QQBot 下「@bot 触发」是唯一调用形态
  //（群 bot 只收 @ 消息，适配器还会给每条群消息补一个 at-bot 段），at-bot 的 qq 是
  // 纯数字 self_id，被误当代查目标 → 水鱼查不到该 QQ → 全量群整个查询被闭环堵死。
  // OneBot 侧 `@bot #mai b50` 同样存在此隐患，一并修复。
  // 官方环境的 at-他人 是 `self_id:openid` 形态（非纯数字），照旧被下面的数字校验拒绝；
  // at-all 的 e.at='all' 同样不过数字校验。
  let targetKey = String(e.user_id ?? '')
  if (allowAt && e.at != null && /^\d+$/.test(String(e.at))) {
    targetKey = String(e.at)
  }
  if (!targetKey) return null

  let user = database.getUser(targetKey)
  const exists = Boolean(user)
  if (!user && autoCreate) {
    user = database.updateUser(targetKey, { service: 'df', theme: 'prism_plus' })
  }

  let authExist = false
  if (requireAuth && user) {
    // 落雪凭据有三类：OAuth 令牌、好友码、或都没有。
    // 只有好友码（`#mai bind fc`）也算「有凭据」——B50/AP50/单曲仍可查（走开发者 API），
    // 真需要 OAuth 的功能（全量成绩系）由 lib/client/lxns.js:allBest 抛 LXNSAuthRequiredError，
    // 在那一步给出精确引导，而不是在这里一刀切地拦住。
    if (user.service === 'lxns' && !user.accessToken && !user.refreshToken && !(user.friendCode > 0)) {
      if (checkSkip) return null
      await e.reply(authorizeError(botName), true)
      return null
    }
    authExist = true
  }

  if (checkSkip && !authExist) return null

  // 返回对象挂用户键（openid / 数字 QQ 串原样）供写路径按 key 落库；
  // 拷贝不 mutate 原行——避免 key 字段被后续整库写盘持久化进 user.json
  user = { ...user, key: targetKey }
  return { user, targetQq: targetKey }
}

/**
 * 实际生效数据源：显式 service 优先；
 * 行内 service 缺失（历史写入丢失）时按「持有落雪凭据 → lxns，否则 df」兜底，
 * 避免 undefined!=='lxns' 恒真导致绑定用户误走水鱼分支（openid 无 QQ → calc 静默降级）
 */
export function effectiveService(user) {
  if (!user) return 'df'
  if (user.service) return user.service
  return user.accessToken || user.refreshToken ? 'lxns' : 'df'
}
