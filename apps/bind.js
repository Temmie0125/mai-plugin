/**
 * #mai bind lxns/df · source · theme（源 commands/mai_base.py bind/source/theme 直译，设计 §3.2-4/5/6/7/8 §4.1/§7.3）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * - 落雪：OAuth 授权码流 → 授权 URL 回复 → setContext('waitLxnsCode') 用户级拦截（600s，宿主兜底超时）
 * - 水鱼：服务端 on-behalf + 确认码回填（handoff=code → 授权页给码 → 用户发回 → redeem 兑换），
 *   等码会话经 setContext('waitDfCode')（20min = 授权链接 10min + 确认码 10min，源 DIVINGFISH_SESSION_TTL）；
 *   不落本地凭据；单一会话不变量：任一侧发起新绑定即 finish 对方上下文（源 pending_bindings 每
 *   (self_id, user_id) 仅一条的语义——落雪授权码正则恰好能匹配水鱼码，两家居上下文会互相抢码）
 * - bind 落凭据；落雪绑定完成自动切到落雪源（源无此行为，本移植优化）；其余切换 #mai source
 * - 绑定失败按源两档文案分类（LXNS 六错误类 → 「授权码可能已使用/过期」；其余 → 「暂时失败」），
 *   显式 instanceof 名单（JS ApiError 单根无法按根分类），不进 handlerError 查询文案表
 */
import plugin from '../../../lib/plugins/plugin.js'
import Config, { head } from '../lib/config.js'
import * as database from '../lib/database.js'
import { getUserAndAuth, effectiveService } from '../lib/user.js'
import { bindLxns, bindDivingfish, completeDivingfishBinding, bindFriendCode, DF_QQ_HINT } from '../lib/handler.js'
import { botName } from '../lib/render/picmodle.js'
import {
  buildAuthorizeUrl, extractAuthorizationCode, isBindingChannelAllowed,
} from '../lib/lxnsOauth.js'
import { bindingLabel, extractConfirmationCode, REVOKE_URL } from '../lib/client/divingfishOauth.js'
import { serviceDisplay, serviceNameByIndex, serviceHelp, themeNameByIndex, themeHelp } from '../lib/merge/models.js'
import {
  DivingFishBindingMismatchError, DivingFishConfirmationCodeError,
  LXNSNotFoundError, LXNSOAuthError, LXNSParamsError,
  LXNSPermissionDeniedError, LXNSTokenError, LXNSTooManyRequestsError,
} from '../lib/client/errors.js'

const H = () => head()

const REG_BIND_LXNS = () => new RegExp(`^[#/]${H()}\\s*(?:bind\\s+(?:lxns|lx|落雪)|lxbind|绑定落雪|绑定lx)(?:\\s+(.+))?$`)
const REG_BIND_DF = () => new RegExp(`^[#/]${H()}\\s*(?:bind\\s+(?:df|水鱼)|dfbind|绑定水鱼|绑定df)(?:\\s+(.+))?$`)
const REG_BIND_QQ = () => new RegExp(`^[#/]${H()}\\s*(?:bind\\s+(?:qq|QQ)|绑定(?:qq|QQ))(?:\\s+(\\S+))?$`)
/** 好友码绑定：`#mai bind fc [好友码]` / `#mai bind 好友码 [好友码]`（不带参数时按 QQ 自动解析） */
const REG_BIND_FC = () => new RegExp(`^[#/]${H()}\\s*(?:bind\\s+(?:fc|FC|好友码)|绑定(?:fc|FC|好友码))(?:\\s+(\\d+))?\\s*$`)
const REG_BIND = () => new RegExp(`^[#/]${H()}\\s*(?:bind|绑定)\\s*$`)
const REG_UNBIND = () => new RegExp(`^[#/]${H()}\\s*(?:unbind|解绑)(?:\\s+(\\S+))?$`)
const REG_SOURCE = () => new RegExp(`^[#/]${H()}\\s*(?:source|数据源)(?:\\s+(\\S+))?$`)
const REG_THEME = () => new RegExp(`^[#/]${H()}\\s*(?:theme|主题)(?:\\s+(\\S+))?$`)

const logger = global.logger || console

// ===================== source/theme 参数解析：枚举序数字 或 字面别名（消除与「bind lxns」提示的割裂） =====================
const SERVICE_LITERALS = {
  lxns: 'lxns', 'lxns-network': 'lxns', 落雪: 'lxns',
  df: 'df', 'diving-fish': 'df', 水鱼: 'df',
}
const THEME_LITERALS = {
  'prism_plus': 'prism_plus', prism: 'prism_plus', 默认: 'prism_plus',
  circle: 'circle',
}

function resolveSourceArg(arg) {
  if (!arg) return null
  return serviceNameByIndex(arg) ?? SERVICE_LITERALS[String(arg).toLowerCase()] ?? null
}

function resolveThemeArg(arg) {
  if (!arg) return null
  return themeNameByIndex(arg) ?? THEME_LITERALS[String(arg).toLowerCase()] ?? null
}

// ===================== 文案（源 mai_base.py:40-111 逐条 1:1；「lxbind」收编为当前子命令写法） =====================
const LXNS_BIND_CMD = () => `#${H()} bind lxns`

/** 落雪绑定引导文案（导出供单测锁值，同 classifyBindError 先例） */
export function authorizeMsg(cfg) {
  const url = buildAuthorizeUrl(cfg.lxClientId, cfg.lxRedirectUri)
  return [
    `请完成落雪账号绑定：`,
    '',
    `1. 打开以下链接并允许「${botName()} BOT」访问您的落雪查分器数据`,
    '=======================',
    url,
    '=======================',
    '2. 授权完成后，复制页面显示的授权码',
    '3. 回到 QQ，直接发送授权码或完整回调链接',
    '',
    '本次绑定有效期为 10 分钟，授权码只能使用一次；',
    `超时或失效后请重新发送「${LXNS_BIND_CMD()}」获取授权链接`,
    '=======================',
    '请注意！！您必须在落雪查分器',
    '「账号设置 → 隐私设置」中开启以下三个选项，',
    '否则BOT将无法获取您的落雪数据：',
    '・允许读取玩家信息',
    '・允许读取谱面成绩',
    '・允许读取历史成绩',
  ].join('\n')
}

const LXNS_ERROR = 'BOT管理员尚未配置落雪查分器相关信息'

/** 裸 `#mai bind`（不带参数）的绑定类型引导 */
const BIND_GUIDE = [
  '请指定要绑定的类型：',
  `・#${H()} bind lxns —— 绑定落雪查分器（授权后可查询/切换到落雪数据源）`,
  `・#${H()} bind fc [好友码] —— 只绑好友码（免授权；可查 B50 / AP50 / 单曲，不带参数时按 QQ 解析）`,
  `・#${H()} bind df —— 绑定水鱼查分器（授权后 BOT 可代查您的水鱼成绩）`,
  `・#${H()} bind qq <QQ号> —— 官方QQBot 环境补充游戏 QQ（解锁水鱼查询）`,
  `・#${H()} unbind <lxns|df|qq> 解除绑定 · #${H()} source 切换数据源`,
].join('\n')

const GROUP_BIND_GUIDE = [
  'BOT 管理员已将落雪绑定设置为仅私聊。',
  `请添加 Bot 为好友后，在私聊中发送「${LXNS_BIND_CMD()}」开始绑定。`,
  '部分 OneBot 实现无法接收陌生人的私聊消息；若没有响应，请先确认好友关系。',
].join('\n')
const INVALID_CODE_MSG = [
  '未识别到有效的落雪授权码。',
  '请发送授权页面显示的完整授权码，或直接粘贴完整回调链接。',
].join('\n')
const OAUTH_FAILED_MSG = [
  '落雪绑定失败：授权码可能已使用、已过期，或授权未成功。',
  '当前绑定会话仍有效，您可以发送新的授权码；',
  `如需重新授权，请再次发送「${LXNS_BIND_CMD()}」。`,
].join('\n')
const BINDING_TEMPORARY_FAILED_MSG = [
  '落雪绑定暂时失败：网络、响应数据或本地数据库出现异常。',
  '当前绑定会话仍有效，您可以稍后重新发送授权码；',
  `如果授权码已经使用，请再次发送「${LXNS_BIND_CMD()}」重新授权。`,
].join('\n')
const LXNS_TIMEOUT_MSG = () => `授权绑定已超时，请重新发送「${LXNS_BIND_CMD()}」获取授权链接`

/** 好友码绑定失败的两档文案（与落雪绑定同款思路：先指路，再兜底） */
const BIND_FC_FAILED_MSG = () => [
  '好友码绑定失败：落雪按 QQ 没有返回可用的好友码。',
  '常见原因：① 未在落雪绑定过 QQ；② 未开启落雪「账号设置 → 隐私设置」的三项读取权限；',
  '③ BOT 的落雪开发者 Token 未配置。',
  `※ 可直接用「#${H()} bind fc <好友码>」手动填写好友码。`,
].join('\n')
const BIND_FC_BUSY_MSG = () => `好友码绑定暂时失败：落雪接口暂时不可用，请稍后再试，或用「#${H()} bind fc <好友码>」手动填写。`

/**
 * 好友码绑定异常 → 文案（与 classifyBindError 同款显式 instanceof 名单）
 * - NotFound / PermissionDenied：落雪明确回「没有这个资源/权限」→ 指路隐私设置与手输
 * - 其余（OAuth 令牌、限流、网络、未知）：暂时性 → 建议稍后重试
 */
export function classifyBindFcError(error) {
  if (error instanceof LXNSNotFoundError
    || error instanceof LXNSPermissionDeniedError
    || error instanceof LXNSTokenError) {
    return BIND_FC_FAILED_MSG()
  }
  logger.warn?.(`[mai-plugin] 好友码绑定失败：${error?.name || ''} ${error?.message || error}`)
  return BIND_FC_BUSY_MSG()
}

const DIVINGFISH_OAUTH_ERROR = 'BOT管理员尚未配置水鱼查分器 OAuth 应用，无法进行绑定授权。'
const DIVINGFISH_BIND_FAILED_MSG = '发起水鱼授权失败：水鱼账号服务可能暂时不可用，请稍后再试。'

/** 水鱼绑定指令展示名（文案内指路统一走它；实际两种写法都可触发） */
const DF_BIND_CMD = () => `#${H()} bind df`

/** 等码会话时长（源 DIVINGFISH_SESSION_TTL = 20min：授权链接 10min + 确认码 10min） */
const DIVINGFISH_SESSION_TTL = 20 * 60
const DIVINGFISH_TIMEOUT_MSG = () => `水鱼授权会话已超时，请重新发送「${DF_BIND_CMD()}」获取授权链接`
const DIVINGFISH_NO_SESSION_MSG = () => `请先发送「${DF_BIND_CMD()}」获取授权链接，完成授权后再发送确认码。`
const DIVINGFISH_INVALID_CODE_MSG = [
  '未识别到有效的水鱼确认码。',
  '请发送授权完成页面显示的完整确认码，形如 BCDF-GHJK-LMNP。',
].join('\n')
const DIVINGFISH_CODE_FAILED_MSG = [
  '水鱼绑定失败：确认码可能已使用、已过期，或不是本次绑定的确认码。',
  `当前绑定会话仍有效，您可以发送新的确认码；如需重新授权，请再次发送「${DF_BIND_CMD()}」。`,
].join('\n')
const DIVINGFISH_MISMATCH_MSG = [
  '水鱼绑定失败：这串确认码对应的授权不属于您的账号。',
  '确认码只能由发起绑定的本人使用，请勿使用他人转发给您的确认码。',
  `如需绑定自己的账号，请发送「${DF_BIND_CMD()}」重新走一遍授权。`,
].join('\n')
const DIVINGFISH_BIND_SUCCESS_MSG = '水鱼查分器授权完成，现在可以直接使用查询指令了。'
const DIVINGFISH_CODE_TEMPORARY_FAILED_MSG = [
  '水鱼绑定暂时失败：水鱼账号服务或网络出现异常。',
  `当前绑定会话仍有效，您可以稍后重新发送确认码；如果确认码已经使用，请再次发送「${DF_BIND_CMD()}」重新授权。`,
].join('\n')

/**
 * 水鱼绑定失败分档（源 complete_divingfish except 分支）；导出供单测锁值。
 * Mismatch（码有效但不是发给这个 QQ 的）照实说清，别让用户以为是自己操作错了。
 */
export function classifyDfBindError(error) {
  if (error instanceof DivingFishBindingMismatchError) return DIVINGFISH_MISMATCH_MSG
  if (error instanceof DivingFishConfirmationCodeError) return DIVINGFISH_CODE_FAILED_MSG
  return DIVINGFISH_CODE_TEMPORARY_FAILED_MSG
}

// =====================================================================
// 授权消息的撤回（水鱼/落雪通用）
// =====================================================================

/**
 * 已发出的授权链接消息登记：用户键 → 链接消息在哪个会话、message_id 是多少
 *
 * 为什么自己记一份：宿主 setContext 存的是「发起绑定那一刻的事件」，拿不到 Bot 回复的
 * message_id；而授权码多半从**另一个会话**发回来（群里拿链接、私聊发码），撤回时也得知道
 * 链接当初发在哪个群/哪个好友那里。
 */
const authLinks = new Map()
/** 登记有效期：比 20 分钟的等码会话略长，过期未收到码即作废 */
const AUTH_LINK_TTL = 25 * 60 * 1000

const authLinkKey = e => `${e.self_id ?? ''}:${e.user_id ?? ''}`

/** 撤回一条授权链接消息（优先用当前会话的 group/friend，跨会话时走 pickGroup/pickFriend） */
async function recallAuthLink(record, e) {
  const sameGroup = record.groupId != null && String(record.groupId) === String(e?.group_id ?? '')
  const sameFriend = record.groupId == null && !e?.isGroup && String(record.userId) === String(e?.user_id ?? '')
  try {
    if (sameGroup && e.group?.recallMsg) {
      await e.group.recallMsg(record.messageId)
      return true
    }
    if (sameFriend && e.friend?.recallMsg) {
      await e.friend.recallMsg(record.messageId)
      return true
    }
    const target = record.groupId != null
      ? globalThis.Bot?.pickGroup?.(record.groupId)
      : globalThis.Bot?.pickFriend?.(record.userId)
    if (target?.recallMsg) {
      await target.recallMsg(record.messageId)
      return true
    }
  } catch { /* 超时（QQ 的自撤回窗口）/无权限：静默，改由文案提醒 */ }
  return false
}

/**
 * 记下刚发出的授权链接消息，供收到授权码后撤回
 *
 * 同一用户再发一次链接时，把上一轮的链接顺手撤掉——那串链接是一次性的，留着只是暴露面。
 * 平台没回 message_id（部分适配器不返回）时不登记，功能自动降级成「只提醒」。
 */
export function rememberAuthLink(e, sent) {
  const messageId = sent?.message_id
  if (!messageId) return
  const now = Date.now()
  for (const [key, value] of authLinks) if (now - value.at > AUTH_LINK_TTL) authLinks.delete(key)
  const prev = authLinks.get(authLinkKey(e))
  if (prev) void recallAuthLink(prev, e)
  authLinks.set(authLinkKey(e), {
    groupId: e.group_id ?? null, userId: e.user_id ?? null, messageId, at: now,
  })
}

/**
 * 收码后的收尾说明（撤到什么程度就说什么；配置关闭时只提醒，不撤）
 *
 * `hadLink=false` 表示本轮没有登记过链接（直接用 `#mai bind <码>` 交码、或重启后登记已丢），
 * 那种情况下不该提"授权链接"——用户手里根本没有这条消息。
 * @param {{configured: boolean, hadLink?: boolean, linkRecalled?: boolean, codeRecalled?: boolean}} state
 */
export function authCleanupHint({ configured, hadLink = true, linkRecalled = false, codeRecalled = false }) {
  const remindCode = '请及时撤回上面那条含授权码的消息'
  if (!configured) {
    return `※ 为保护账号安全，${remindCode}${hadLink ? '（授权链接也请一并撤回）' : ''}`
  }
  if (linkRecalled && codeRecalled) return '※ 已自动撤回授权链接与授权码消息'
  if (codeRecalled) return `※ 已自动撤回授权码消息${hadLink ? '；授权链接未能撤回' : ''}`
  if (linkRecalled) return `※ 已自动撤回授权链接；${remindCode}`
  return `※ ${hadLink ? '授权链接与授权码消息都没能撤回，请及时手动撤回' : remindCode}`
}

/**
 * 授权码到手后的现场清理（LXNS / 水鱼两条绑定路径共用，收码处调用一次）
 *
 * - 配置开启（默认）：撤回 Bot 发的那条授权链接消息
 * - 绑定**成功**、且处于群聊、且 Bot 是群管理/群主时：连用户的授权码消息一起撤
 *   （失败时留着——那条码可能还能重发，见各档失败文案里的「重新发送确认码」引导）
 * - 撤不动（无权限/超窗口/非群聊/平台不支持）或配置关闭：回一句提醒由调用方附在回执末尾
 *
 * @returns {Promise<string>} 附在回执末尾的说明
 */
export async function settleAuthMessages(e, { success = false } = {}) {
  const configured = Config.getUserCfg('config', 'autoRecallAuthMsg') !== false
  const key = authLinkKey(e)
  const record = authLinks.get(key)
  authLinks.delete(key)

  const linkRecalled = configured && record ? await recallAuthLink(record, e) : false
  // 撤回他人的消息要群管理权限；私聊里 Bot 撤不了对方的消息（宿主同样不撤触发消息）
  const canRecallCode = Boolean(e.isGroup && (e.group?.is_admin || e.group?.is_owner))
  let codeRecalled = false
  if (configured && success && canRecallCode && e.recall) {
    try {
      await e.recall()
      codeRecalled = true
    } catch { /* 落到提醒 */ }
  }
  return authCleanupHint({ configured, hadLink: Boolean(record), linkRecalled, codeRecalled })
}

const BIND_QQ_HELP = [
  `用法：#${H()} bind qq <你的QQ号>（解除：bind qq clear）`,
  '※ 官方QQBot 环境只有 openid、读不到 QQ 号；水鱼查分器按 QQ 代查需你主动提供一次，',
  '   仅写入本插件本地数据（data/user.json），用于水鱼授权与查询。',
].join('\n')

const UNBIND_HELP = [
  `用法：#${H()} unbind <lxns|df|qq>（别名：解绑）`,
  '・lxns/落雪：清除本地落雪凭据与好友码；指针在落雪时自动切回水鱼',
  '・df/水鱼：清本地令牌缓存并提供服务端撤销页（水鱼凭据不落 BOT）',
  '・qq：解除「bind qq」补充的游戏 QQ（官方QQBot 水鱼将重新受限）',
].join('\n')

/** 水鱼授权文案（源 DIVINGFISH_AUTHORIZE_MSG：回填确认码版，3 步；导出供单测锁值） */
export function divingfishAuthorizeMsg(cfg, authorization) {
  return [
    '请完成水鱼查分器授权：',
    '',
    `1. 打开以下链接并登录水鱼账号，授权「${botName()} BOT」访问您的水鱼查分器数据`,
    '=======================',
    authorization.verification_uri_complete,
    '=======================',
    `2. 确认页面显示的绑定身份为「${authorization.binding_label}」后点击「同意授权」`,
    '3. 复制页面给出的确认码，回到 QQ 发送给 BOT',
    '',
    `本次绑定 ${Math.max(Math.floor(authorization.expires_in / 60), 1)} 分钟内有效，确认码只能使用一次；`,
    `超时或失效后请重新发送「${DF_BIND_CMD()}」。`,
    '=======================',
    '请注意！！链接与确认码都仅供您本人使用，请勿转发他人。',
    '确认码建议在与 BOT 的私聊中发送，避免被他人看到。',
    `如需取消授权，请前往 ${(cfg.dfAuthUrl || 'https://auth.diving-fish.com').replace(/\/+$/, '')}${REVOKE_URL}`,
  ].join('\n')
}

/** 绑定失败两档分类（源 complete_lxns_binding except 分支）；导出供单测锁值 */
export function classifyBindError(error) {
  const httpFamily = [LXNSTokenError, LXNSOAuthError, LXNSParamsError,
    LXNSPermissionDeniedError, LXNSNotFoundError, LXNSTooManyRequestsError]
  return httpFamily.some(cls => error instanceof cls)
    ? OAUTH_FAILED_MSG
    : BINDING_TEMPORARY_FAILED_MSG
}

export class MaiBind extends plugin {
  constructor() {
    super({
      name: 'mai-bind',
      dsc: '舞萌DX绑定与设置',
      event: 'message',
      priority: 100,
      rule: [
        { reg: `^[#/]${H()}\\s*(?:bind\\s+(?:lxns|lx|落雪)|lxbind|绑定落雪|绑定lx)(?:\\s+(.+))?$`, fnc: 'bindLxnsCmd' },
        { reg: `^[#/]${H()}\\s*(?:bind\\s+(?:df|水鱼)|dfbind|绑定水鱼|绑定df)(?:\\s+(.+))?$`, fnc: 'bindDfCmd' },
        { reg: `^[#/]${H()}\\s*(?:bind\\s+(?:qq|QQ)|绑定(?:qq|QQ))(?:\\s+(\\S+))?$`, fnc: 'bindQqCmd' },
        // 好友码绑定：规则串取 REG_BIND_FC().source，与 fnc 内解析共用同一份（防漂移）
        { reg: REG_BIND_FC().source, fnc: 'bindFcCmd' },
        { reg: `^[#/]${H()}\\s*(?:bind|绑定)\\s*$`, fnc: 'bindGuide' },
        { reg: `^[#/]${H()}\\s*(?:unbind|解绑)(?:\\s+(\\S+))?$`, fnc: 'unbindCmd' },
        { reg: `^[#/]${H()}\\s*(?:source|数据源)(?:\\s+(\\S+))?$`, fnc: 'switchSource' },
        { reg: `^[#/]${H()}\\s*(?:theme|主题)(?:\\s+(\\S+))?$`, fnc: 'switchTheme' },
      ],
    })
  }

  /** #mai bind lxns（无参=发授权链接+挂起拦截；带参=直接尝试完成） */
  async bindLxnsCmd(e) {
    const cfg = Config.getUserCfg('config')
    if (!isBindingChannelAllowed({ privateOnly: cfg.lxnsBindPrivateOnly, isPrivate: !e.isGroup })) {
      await this.reply(GROUP_BIND_GUIDE, true)
      return true
    }
    if (!(cfg.lxClientId && cfg.lxClientSecret && cfg.lxRedirectUri)) {
      await this.reply(`${LXNS_ERROR}，无法进行绑定授权。`, true)
      return true
    }
    const text = ((e.msg.match(REG_BIND_LXNS()) || [])[1] || '').trim()
    if (!text) {
      rememberAuthLink(e, await this.reply(authorizeMsg(cfg), true))
      // 单一会话不变量：发起新绑定即作废水鱼等码会话（源 pending_bindings 每 (self_id, user_id) 仅一条）
      this.finish('waitDfCode')
      this.setContext('waitLxnsCode', false, 600, LXNS_TIMEOUT_MSG())
      return true
    }
    return await this.completeBinding(e, text)
  }

  /**
   * #mai bind df：无参=发起授权+挂起等码会话；带参=直接用确认码完成绑定
   * （源 df_bind / df_bind_code 语义：先会话后验码——没有会话时即使消息像码也回
   * NO_SESSION，防止把别人转发来的码烧掉）
   */
  async bindDfCmd(e) {
    const cfg = Config.getUserCfg('config')
    if (!(cfg.dfClientId && cfg.dfClientSecret)) {
      await this.reply(DIVINGFISH_OAUTH_ERROR, true)
      return true
    }
    const text = ((e.msg.match(REG_BIND_DF()) || [])[1] || '').trim()
    if (text) {
      if (!this.getContext('waitDfCode')) {
        await this.reply(DIVINGFISH_NO_SESSION_MSG(), true)
        return true
      }
      const code = extractConfirmationCode(text)
      if (!code) {
        await this.reply(DIVINGFISH_INVALID_CODE_MSG, true)
        return true
      }
      return await this.completeDfBinding(e, code)
    }
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
    if (!got) return true
    if (!Number.isInteger(got.user.qqid) || got.user.qqid <= 0) {
      // 官方QQBot(openid)环境无水鱼所需的 QQ 号
      await this.reply(DF_QQ_HINT(), true)
      return true
    }
    try {
      const authorization = await bindDivingfish(got.user.qqid)
      // 单一会话不变量：发起新绑定即作废落雪等码会话（源 pending_bindings 每 (self_id, user_id) 仅一条）
      this.finish('waitLxnsCode')
      rememberAuthLink(e, await this.reply(divingfishAuthorizeMsg(cfg, {
        ...authorization,
        binding_label: bindingLabel(got.user.qqid),
      }), true))
      this.setContext('waitDfCode', false, DIVINGFISH_SESSION_TTL, DIVINGFISH_TIMEOUT_MSG())
    } catch (error) {
      logger.warn(`[mai-plugin] 水鱼授权发起失败：${error?.name || error?.message}`)
      await this.reply(DIVINGFISH_BIND_FAILED_MSG, true)
    }
    return true
  }

  /**
   * 裸 `#mai bind`（不带参数）：绑定类型引导（此前该形态不匹配任何规则、无任何回复）
   */
  async bindGuide(e) {
    await this.reply(BIND_GUIDE, true)
    return true
  }

  /** #mai bind qq <QQ号>：官方QQBot(openid) 环境主动补充游戏 QQ（解锁水鱼）；bind qq clear 解除 */
  async bindQqCmd(e) {
    const args = ((e.msg.match(REG_BIND_QQ()) || [])[1] || '').trim()
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
    if (!got) return true
    // OneBot 环境用户键本身即 QQ，无需也无法被覆盖（防冒用他人 QQ 查询）
    if (/^\d+$/.test(got.user.key)) {
      await this.reply('当前环境可直接读取 QQ 号，无需补充绑定。', true)
      return true
    }
    if (!args) {
      await this.reply(BIND_QQ_HELP, true)
      return true
    }
    if (['clear', '解除', '解绑', '清除'].includes(args.toLowerCase())) {
      database.updateUser(got.user.key, { qqid: null })
      await this.reply('已解除游戏 QQ 绑定，水鱼查分器功能将不可用（可随时重新 bind qq 补充）。', true)
      return true
    }
    if (!/^\d{5,12}$/.test(args)) {
      await this.reply(`QQ 号格式不正确，请发送 5~12 位数字。\n${BIND_QQ_HELP}`, true)
      return true
    }
    const qq = Number(args)
    database.updateUser(got.user.key, { qqid: qq })
    await this.reply(
      `已绑定游戏 QQ「${qq}」。\n` +
      `※ 官方QQBot 环境无法自读 QQ 号，水鱼查分器现在起可用：发送「#${H()} bind df」完成授权后即可查分。`,
      true,
    )
    return true
  }

  /**
   * `#mai bind fc [好友码]`：按好友码绑定落雪（免 OAuth 的轻量绑定）
   *
   * 与 `bind lxns` 的分工见 lib/handler.js:bindFriendCode —— 好友码足以查
   * B50 / AP50 / 单曲（走落雪开发者接口，要求账号开启三项隐私设置），
   * 全量成绩系仍需 OAuth。不带参数时按 QQ 自动解析好友码。
   *
   * 绑定类命令**不包 handleErrors**（本文件既有约定）：异常按绑定场景分类文案。
   */
  async bindFcCmd(e) {
    const arg = ((e.msg || '').match(REG_BIND_FC()) || [])[1] || null
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
    if (!got) return true
    try {
      await this.reply(await bindFriendCode(got.user, arg), true)
    } catch (error) {
      await this.reply(classifyBindFcError(error), true)
    }
    return true
  }

  /**
   * 上下文路由（宿主 ctx 范式：无参，当前消息读 this.e；源 bind_code 语义）
   * - 非授权码消息 → 'continue' 放行；仅私聊开关下群消息 → 释放上下文放行
   * - 命中授权码 → 完成绑定；失败保持会话（源 pending 语义，宿主 ctx 兜底 600s）
   */
  async waitLxnsCode() {
    const e = this.e
    const cfg = Config.getUserCfg('config')
    if (e.isGroup && cfg.lxnsBindPrivateOnly) {
      this.finish('waitLxnsCode')
      return 'continue'
    }
    const text = (e.msg || '').trim()
    if (extractAuthorizationCode(text) == null) return 'continue'
    return await this.completeBinding(e, text)
  }

  /** 授权码完成绑定（命令内联 / 上下文两路共用）；失败保持/重挂会话 */
  async completeBinding(e, text) {
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
    if (!got) return true
    // 单一会话不变量：落雪绑定动作取代水鱼等码会话（源 pending_bindings 语义）
    this.finish('waitDfCode')
    try {
      const result = await bindLxns(got.user, extractAuthorizationCode(text))
      this.finish('waitLxnsCode')
      await this.reply(`${result}\n${await settleAuthMessages(e, { success: true })}`, true)
    } catch (error) {
      logger.warn(`[mai-plugin] 落雪绑定失败：${error?.stack || error}`)
      await this.reply(`${classifyBindError(error)}\n${await settleAuthMessages(e)}`, true)
      this.setContext('waitLxnsCode', false, 600, LXNS_TIMEOUT_MSG())
    }
    return true
  }

  /**
   * 确认码完成水鱼绑定（命令内联 / waitDfCode 上下文两路共用，源 df_bind_code 语义）
   * 成功即结束会话；失败按分档文案回复并保持/重挂会话（码未被消费可重发）
   */
  async completeDfBinding(e, code) {
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
    if (!got) return true
    // 单一会话不变量：水鱼绑定动作取代落雪等码会话
    this.finish('waitLxnsCode')
    if (!Number.isInteger(got.user.qqid) || got.user.qqid <= 0) {
      this.finish('waitDfCode')
      await this.reply(DF_QQ_HINT(), true)
      return true
    }
    try {
      await completeDivingfishBinding(got.user.qqid, code)
      this.finish('waitDfCode')
      await this.reply(`${DIVINGFISH_BIND_SUCCESS_MSG}\n${await settleAuthMessages(e, { success: true })}`, true)
    } catch (error) {
      logger.warn(`[mai-plugin] 水鱼绑定失败：${error?.name || error?.message || error}`)
      await this.reply(`${classifyDfBindError(error)}\n${await settleAuthMessages(e)}`, true)
      this.setContext('waitDfCode', false, DIVINGFISH_SESSION_TTL, DIVINGFISH_TIMEOUT_MSG())
    }
    return true
  }

  /**
   * waitDfCode 上下文路由（源 df_bind_code 裸消息匹配器语义）
   * - 非确认码消息 → 'continue' 放行（等码期间正常聊天/指令不受影响）
   * - 命中确认码 → 完成绑定
   */
  async waitDfCode() {
    const e = this.e
    const code = extractConfirmationCode(e.msg || '')
    if (!code) return 'continue'
    return await this.completeDfBinding(e, code)
  }

  /**
   * #mai unbind <lxns|df|qq>：解除对应绑定（绑定闭环收口）
   * - lxns：清空本地凭据与好友码；若数据源指针在落雪 → 自动切回水鱼（否则指针停在空源）
   * - df  ：本地无凭据可清（服务端 on-behalf）；清 5 分钟 TokenCache，给出水鱼撤销页，
   *          指针在水鱼且已绑落雪时自动切落雪
   * - qq  ：清除补充的游戏 QQ（官方QQBot 水鱼将重新受限）
   */
  async unbindCmd(e) {
    const args = ((e.msg.match(REG_UNBIND()) || [])[1] || '').trim().toLowerCase()
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
    if (!got) return true
    const { user } = got
    const cfg = Config.getUserCfg('config')

    if (!args || !['lxns', '落雪', 'df', '水鱼', 'qq'].includes(args)) {
      await this.reply(UNBIND_HELP, true)
      return true
    }

    if (args === 'lxns' || args === '落雪') {
      const hadCreds = Boolean(user.accessToken || user.refreshToken || user.friendCode)
      database.clearUserFields(user.key, ['accessToken', 'refreshToken', 'friendCode'])
      let tail = hadCreds ? '本地凭据与好友码已清除。' : '本地未发现落雪凭据（可能尚未绑定）。'
      if (effectiveService(database.getUser(user.key)) === 'lxns') {
        database.updateUser(user.key, { service: 'df' })
        tail += '\n数据源指针原在落雪，已自动切回水鱼。'
      }
      await this.reply(
        `已解除落雪绑定（${tail}）\n※ 如需彻底撤销授权，请前往落雪站点「授权管理」取消本应用。`,
        true,
      )
      return true
    }

    if (args === 'df' || args === '水鱼') {
      // 服务端 on-behalf：本地无凭据；清进程内令牌缓存并给出撤销页
      try {
        const { tokens, subjectRef } = await import('../lib/client/divingfishOauth.js')
        if (Number.isInteger(user.qqid) && user.qqid > 0) tokens.discard(subjectRef(user.qqid))
      } catch { /* 缓存清理失败不影响解绑语义 */ }
      let tail = ''
      if (effectiveService(user) === 'df' && (user.accessToken || user.refreshToken)) {
        database.updateUser(user.key, { service: 'lxns' })
        tail = '\n数据源指针原在水鱼，已自动切换为落雪。'
      }
      const revoke = `${(cfg.dfAuthUrl || 'https://auth.diving-fish.com').replace(/\/+$/, '')}${REVOKE_URL}`
      await this.reply(
        '已解除水鱼绑定（本地令牌缓存已清除；水鱼凭据仅存于服务端，无需本地清除）。\n' +
        `※ 彻底撤销授权请前往：${revoke}${tail}`,
        true,
      )
      return true
    }

    // qq：清除补充的游戏 QQ
    database.updateUser(user.key, { qqid: null })
    await this.reply(`已解除游戏 QQ 绑定，水鱼查分器将恢复受限（可随时「#${H()} bind qq」重新补充）。`, true)
    return true
  }

  /** #mai source <0|1|lxns|df>（纯 service 指针切换；缺配防御照源） */
  async switchSource(e) {
    const cfg = Config.getUserCfg('config')
    const args = ((e.msg.match(REG_SOURCE()) || [])[1] || '').trim()
    const source = resolveSourceArg(args)
    if (!source) {
      await this.reply(`未找到该数据源，请输入指定数字或别名切换：\n${serviceHelp()}\n别名：df/水鱼 · lxns/落雪`, true)
      return true
    }
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
    if (!got) return true
    if (source === 'lxns' && !cfg.lxnsDevToken && (!cfg.lxClientId || !cfg.lxRedirectUri)) {
      database.updateUser(got.user.key, { service: 'df' })
      await this.reply(`${LXNS_ERROR}。为防止无法查询成绩，已强制将数据源切换为水鱼查分器。`, true)
      return true
    }
    database.updateUser(got.user.key, { service: source })
    await this.reply(`已切换数据源为：「${serviceDisplay(source)}」`, true)
    return true
  }

  /** #mai theme <0|1|prism_plus|circle> */
  async switchTheme(e) {
    const args = ((e.msg.match(REG_THEME()) || [])[1] || '').trim()
    const theme = resolveThemeArg(args)
    if (!theme) {
      await this.reply(`未找到该主题，请输入指定数字或别名切换：\n${themeHelp()}`, true)
      return true
    }
    const got = await getUserAndAuth(e, { autoCreate: true, allowAt: false })
    if (!got) return true
    database.updateUser(got.user.key, { theme })
    await this.reply(`已切换主题为：「${theme}」`, true)
    return true
  }
}
