/**
 * 水鱼查分器 OAuth（源 core/clients/divingfish/oauth.py 直译，设计 §7.1/7.3）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * BOT 只保管 client_id/client_secret，不保存任何用户令牌：
 *   1. #mai bind df → 带 handoff=code 发起 device_authorization，把授权链接发给用户
 *   2. 用户在水鱼账号页面确认授权，页面给出一串一次性确认码
 *   3. 用户把确认码发回给 BOT，BOT 凭码兑换一次令牌（confirmation-code grant），绑定完成；
 *      「点同意的人」和「发起绑定的人」是否同一，由确认码回填 + subject_ref 比对保证
 *   4. 之后每次代查请求前取 5 分钟有效 access_token（on-behalf-of grant，进程内缓存）
 * 用户标识只以 sha256("<client_id>:<QQ>") 摘要发送，QQ 号不出 BOT。
 */
import crypto from 'node:crypto'
import Config from '../config.js'
import { ApiClient } from './http.js'
import {
  DivingFishBindingMismatchError,
  DivingFishConfirmationCodeError,
  DivingFishNotAuthorizedError,
  DivingFishOAuthError,
  DivingFishTokenNotFoundError,
} from './errors.js'

/** on-behalf-of grant type（源 oauth.py:28） */
const ON_BEHALF_OF_GRANT = 'urn:diving-fish:params:oauth:grant-type:on-behalf-of'
/** 确认码兑换 grant type（源 oauth.py:29） */
const CONFIRMATION_CODE_GRANT = 'urn:diving-fish:params:oauth:grant-type:confirmation-code'

/** 应用 scope：默认权重 4 = prober.records.read（源 DivingFishScope.PROBER_RECORDS_READ 默认） */
export const DEFAULT_DF_SCOPE = 'prober.records.read'

/**
 * 水鱼 OAuth 权限项全集（Guoba 多选同源）。发送格式：空格分隔的权限名
 * （源 divingfish_oauth_scope 语义）；配置侧字符串/数组均可，见 resolveDfScope。
 */
export const DIVINGFISH_SCOPES = {
  profile: '读取你的用户名、昵称、头衔',
  email: '读取你的账号邮箱及其是否已验证',
  'prober.profile.read': '读取你在查分器的资料（Rating、姓名框等）',
  'prober.records.read': '读取你的舞萌 DX 成绩',
}

const logger = global.logger || console

/**
 * 解析 dfScope 配置：数组（Guoba 多选）或空格分隔字符串 → 发送给水鱼的 scope 串
 * 空 / 含未知权限名时不中断绑定，warn 后回退默认值（源侧校验直接抛错，插件侧改为兜底）
 */
export function resolveDfScope(value) {
  const names = (Array.isArray(value) ? value : String(value ?? '').split(/\s+/))
    .map(s => s.trim()).filter(Boolean)
  if (!names.length) return DEFAULT_DF_SCOPE
  // Object.hasOwn 而非 `in`：`in` 连原型链一起认，`dfScope: constructor` 会被当合法权限发出去
  const unknown = names.filter(name => !Object.hasOwn(DIVINGFISH_SCOPES, name))
  if (unknown.length) {
    logger.warn(`[mai-plugin] dfScope 含未知权限项 ${unknown.join('、')}，已回退默认「${DEFAULT_DF_SCOPE}」。可选值：${Object.keys(DIVINGFISH_SCOPES).join(' / ')}`)
    return DEFAULT_DF_SCOPE
  }
  return names.join(' ')
}

/** 提前过期余量（秒），避免令牌在请求途中失效（源 oauth.py:32） */
const EXPIRES_MARGIN = 30

/** 授权撤销页路径（源 oauth.py REVOKE_URL） */
export const REVOKE_URL = '/apps'

/** 用户标识摘要：水鱼服务端用它定位授权过的账号 */
export function subjectRef(qqid) {
  const { dfClientId } = Config.getUserCfg('config')
  return crypto.createHash('sha256').update(`${dfClientId}:${qqid}`).digest('hex')
}

/** 授权页面展示的绑定身份，用户凭它确认不是在给别人授权 */
export function bindingLabel(qqid) {
  const qq = String(qqid)
  if (qq.length <= 4) return `QQ ${qq}`
  return `QQ ${qq.slice(0, 2)}${'*'.repeat(qq.length - 4)}${qq.slice(-2)}`
}

/**
 * 读出 access token 里的 sub（水鱼用户 ID）。**只解不验**：这串令牌是 BOT
 * 刚从水鱼账号服务取回来的，用它比对「兑换出的账号」和「换票换到的账号」
 * 是否同属一人，属自洽性检查而非安全校验——真正的验签由资源服务器做
 */
export function tokenSubject(accessToken) {
  try {
    const payload = String(accessToken).split('.')[1]
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof json?.sub === 'string' ? json.sub : null
  } catch { return null }
}

/** 水鱼确认码只用这 20 个字母：去掉 A/E/I/O/U（避免随机拼出脏词）。L 保留在表内
 * （源示例码 BCDF-GHJK-LMNP 自身就含 L），字母表内不含任何数字（源 divingfish_oauth.py） */
export const CONFIRMATION_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const CONFIRMATION_CODE_LENGTH = 12
const CONFIRMATION_BODY_RE = new RegExp(`^[${CONFIRMATION_ALPHABET}]{${CONFIRMATION_CODE_LENGTH}}$`)
const CONFIRMATION_PREFIX_RE = /^(?:确认码|授权码)\s*[:：]?\s*(\S+)$/

/**
 * 从用户发来的整条消息里认出确认码，归一化成 XXXX-XXXX-XXXX（源 extract_confirmation_code）
 * 容错：小写、连字符/空格/全角破折号/下划线丢失、「确认码：」前缀、首尾空白。
 * 只认「整条消息就是一串码」，不从一句话里抠——否则正常聊天凑巧凑出十二个
 * 字母就会被当成码送去兑换。
 */
export function extractConfirmationCode(text) {
  let value = String(text ?? '').trim()
  const prefixed = value.match(CONFIRMATION_PREFIX_RE)
  if (prefixed) value = prefixed[1]
  const body = value.replace(/[\s\-—_]/g, '').toUpperCase()
  if (!CONFIRMATION_BODY_RE.test(body)) return null
  return body.replace(/(.{4})(?=.)/g, '$1-')
}

/** 进程内令牌缓存（无 refresh_token，过期后重新换取） */
export class TokenCache {
  /**
   * @param {() => number} clock 秒级时钟（单测注入口）；默认 Date.now()/1000
   */
  constructor(clock = null) {
    this._tokens = new Map()
    this._clock = clock ?? (() => Date.now() / 1000)
  }

  /** 命中且未过期（含 30s 余量）返回令牌，否则清除并返回 null */
  get(ref) {
    const cached = this._tokens.get(ref)
    if (!cached) return null
    const [token, expiresAt] = cached
    if (expiresAt <= this._clock()) {
      this._tokens.delete(ref)
      return null
    }
    return token
  }

  set(ref, token) {
    this._tokens.set(ref, [token.access_token, this._clock() + Math.max(token.expires_in - EXPIRES_MARGIN, 0)])
  }

  discard(ref) {
    this._tokens.delete(ref)
  }
}

/** 全局令牌缓存（源模块级 tokens = TokenCache()） */
export const tokens = new TokenCache()

export class DivingFishOAuth extends ApiClient {
  constructor() {
    const cfg = Config.getUserCfg('config')
    super({ baseUrl: (cfg.dfAuthUrl || 'https://auth.diving-fish.com').replace(/\/+$/, '') })
    this.clientId = cfg.dfClientId
    this.clientSecret = cfg.dfClientSecret
  }

  /** 发起绑定：返回 {verification_uri_complete, expires_in, ...}，服务端记录授权关系 */
  async deviceAuthorization(qqid) {
    // 顺带丢弃缓存令牌：绑定到另一账号后旧令牌在过期前会查成上一账号成绩（源注释语义）
    tokens.discard(subjectRef(qqid))
    const cfg = Config.getUserCfg('config')
    return await this._request('POST', '/oauth/device_authorization', {
      form: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: resolveDfScope(cfg.dfScope),
        subject_ref: subjectRef(qqid),
        binding_label: bindingLabel(qqid),
        // 改由用户回填确认码收尾。带上它之后 device_code 换不到令牌，正是其意义所在：
        // 未经点同意的人把码发回来，绑定就完不成（源 oauth.py device_authorization）
        handoff: 'code',
      },
    })
  }

  /** 用用户发回的确认码兑换一次令牌；对不上发起绑定的 subject_ref 时水鱼回 subject_mismatch 且不消费码 */
  async redeem(qqid, confirmationCode) {
    return await this._request('POST', '/oauth/token', {
      form: {
        grant_type: CONFIRMATION_CODE_GRANT,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        confirmation_code: confirmationCode,
        subject_ref: subjectRef(qqid),
      },
    })
  }

  /** 换取代该用户访问的令牌 */
  async fetchToken(qqid) {
    const cfg = Config.getUserCfg('config')
    return await this._request('POST', '/oauth/token', {
      form: {
        grant_type: ON_BEHALF_OF_GRANT,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        subject: `ref:${subjectRef(qqid)}`,
        scope: resolveDfScope(cfg.dfScope),
      },
    })
  }

  async _handleError(resp) {
    if (resp.status === 200) return
    const cfg = Config.getUserCfg('config')
    if (!(cfg.dfClientId && cfg.dfClientSecret)) throw new DivingFishTokenNotFoundError()
    let error = ''
    try { error = (await resp.json()).error ?? '' } catch { /* 保持空串 */ }
    // 失败先留痕：'consent_required' 与下游 API 的 403 会汇成同一句用户文案，
    // 没有这行日志就分不清「没授权过」和「接口 403」，真机排查只能靠猜
    logger.warn(`[mai-plugin] 水鱼账号服务 ${resp.status}${error ? ` ${error}` : ''}：${resp.url || '(未知 URL)'}`)
    if (error === 'consent_required') throw new DivingFishNotAuthorizedError()
    // 码是真的，但不是发给这个 QQ 的——多半把别人转发来的码当成了自己的（水鱼不消费该码）
    if (error === 'subject_mismatch') throw new DivingFishBindingMismatchError()
    // 码不存在/过期/已用/出自别的应用，水鱼一律回这个错，不作区分
    if (error === 'invalid_grant') throw new DivingFishConfirmationCodeError()
    throw new DivingFishOAuthError()
  }
}

/**
 * 取该用户令牌：命中缓存直接复用；refresh=true 丢弃缓存重新换取
 */
export async function getAccessToken(qqid, { refresh = false } = {}) {
  const ref = subjectRef(qqid)
  if (refresh) tokens.discard(ref)
  else {
    const cached = tokens.get(ref)
    if (cached) return cached
  }
  const result = await new DivingFishOAuth().fetchToken(qqid)
  tokens.set(ref, result)
  return result.access_token
}
