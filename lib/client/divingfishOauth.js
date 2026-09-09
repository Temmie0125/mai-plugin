/**
 * 水鱼查分器 OAuth（源 core/clients/divingfish/oauth.py 直译，设计 §7.1/7.3）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * BOT 只保管 client_id/client_secret，不保存任何用户令牌：
 *   1. #mai bind df → device_authorization 拿授权链接发给用户（服务端授权，无轮询）
 *   2. 之后每次代查请求前取 5 分钟有效 access_token（on-behalf-of grant，进程内缓存）
 * 用户标识只以 sha256("<client_id>:<QQ>") 摘要发送，QQ 号不出 BOT。
 */
import crypto from 'node:crypto'
import Config from '../config.js'
import { ApiClient } from './http.js'
import {
  DivingFishNotAuthorizedError,
  DivingFishOAuthError,
  DivingFishTokenNotFoundError,
} from './errors.js'

/** on-behalf-of grant type（源 oauth.py:28） */
const ON_BEHALF_OF_GRANT = 'urn:diving-fish:params:oauth:grant-type:on-behalf-of'

/** 应用 scope：默认权重 4 = prober.records.read（源 DivingFishScope.PROBER_RECORDS_READ 默认） */
const SCOPE = 'prober.records.read'

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
    return await this._request('POST', '/oauth/device_authorization', {
      form: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: SCOPE,
        subject_ref: subjectRef(qqid),
        binding_label: bindingLabel(qqid),
      },
    })
  }

  /** 换取代该用户访问的令牌 */
  async fetchToken(qqid) {
    return await this._request('POST', '/oauth/token', {
      form: {
        grant_type: ON_BEHALF_OF_GRANT,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        subject: `ref:${subjectRef(qqid)}`,
        scope: SCOPE,
      },
    })
  }

  async _handleError(resp) {
    if (resp.status === 200) return
    const cfg = Config.getUserCfg('config')
    if (!(cfg.dfClientId && cfg.dfClientSecret)) throw new DivingFishTokenNotFoundError()
    let error = ''
    try { error = (await resp.json()).error ?? '' } catch { /* 保持空串 */ }
    if (error === 'consent_required') throw new DivingFishNotAuthorizedError()
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
