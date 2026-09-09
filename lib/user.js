/**
 * 用户解析（源 commands/depend.py GetUserModel 五变体 → 参数化单函数，设计 §4.4）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * - 用户键双协议兼容：OneBot=纯数字 QQ；官方 QQBot=openid（原样字符串，不强转数字）
 * - allowAt：扫描消息 at 段取目标 QQ（仅纯数字 at 有效，过滤 bot 自身与 all）
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
  // 用户键：at（纯数字 QQ）优先 → 否则 e.user_id 原样（数字 QQ 或 openid 均可作键）
  let targetKey = String(e.user_id ?? '')
  if (allowAt && Array.isArray(e.message)) {
    for (const item of e.message) {
      if (item?.type === 'at' && item.qq !== 'all' && /^\d+$/.test(String(item.qq))) {
        targetKey = String(item.qq)
      }
    }
  }
  if (!targetKey) return null

  let user = database.getUser(targetKey)
  const exists = Boolean(user)
  if (!user && autoCreate) {
    user = database.updateUser(targetKey, { service: 'df', theme: 'prism_plus' })
  }

  let authExist = false
  if (requireAuth && user) {
    if (user.service === 'lxns' && !user.accessToken && !user.refreshToken) {
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
