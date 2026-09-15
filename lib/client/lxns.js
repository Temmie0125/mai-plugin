/**
 * 落雪查分器客户端（源 core/clients/lxns/client.py 直译，设计 §7.1）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * - OAuth2：授权码换 token / refresh_token 刷新（P2 绑定流使用，此处一并直译）
 * - 401 自动刷新：_onUnauthorized → refresh → 回写 user.json → 单次重试（源 client.py:95 语义）
 */
import Config from '../config.js'
import * as database from '../database.js'
import { ApiClient } from './http.js'
import {
  LXNSAuthRequiredError,
  LXNSNotFoundError,
  LXNSOAuthError,
  LXNSParamsError,
  LXNSPermissionDeniedError,
  LXNSTokenError,
  LXNSTooManyRequestsError,
  UnknownError,
} from './errors.js'

export class OAuth2 extends ApiClient {
  constructor() {
    super({ baseUrl: 'https://maimai.lxns.net' })
    const cfg = Config.getUserCfg('config')
    this.clientId = cfg.lxClientId
    this.clientSecret = cfg.lxClientSecret
    this.redirectUri = cfg.lxRedirectUri
    this.token = null
  }

  /** 授权码换 access_token */
  async fetchToken(code) {
    const result = await this._request('POST', '/api/v0/oauth/token', {
      json: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
      },
    })
    this.token = result
    return result
  }

  async refreshToken() {
    if (!this.token) throw new LXNSTokenError()
    const result = await this._request('POST', '/api/v0/oauth/token', {
      json: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.token.refresh_token,
      },
    })
    this.token = result
    return result
  }

  async _handleError(resp) {
    if (resp.status === 200) return
    if (resp.status === 401) throw new LXNSTokenError()
    throw new LXNSOAuthError()
  }
}

/**
 * 库内凭据是否比本次持有的**更新**（= 本进程内别处刚刷新过：并发命令、
 * 或同一次命令里的另一个 LxnsAPI 实例）。是则返回它，否则 null。
 *
 * 之所以能这样判：refresh_token 单次使用，刷新后 access_token 必变；
 * 库内值与本次持有的相同 ⇒ 没有更新的凭据可用，只能自己去刷。
 */
function newerPersistedToken(userId, current) {
  const row = userId != null ? database.getUser(userId) : null
  const access = row?.accessToken ?? null
  if (!access || access === current) return null
  return { access_token: access, refresh_token: row.refreshToken ?? null }
}

class LxnsClient extends ApiClient {
  constructor({ baseUrl, headers, userId, token = null }) {
    super({ baseUrl, headers, timeout: 180000 })
    this.userId = userId
    this._token = token
  }

  /** 换用给定凭据（并让本次会话后续请求都用它） */
  _adopt(token) {
    this._token = token
    this.headers.Authorization = `Bearer ${token.access_token}`
  }

  async _onUnauthorized() {
    // ① 库内已有更新凭据 → 直接换用重试。省下的不只是一次请求：refresh_token 是
    //    **单次使用**的稀缺资源，多刷一次就多一分把轮换链撞断的风险。
    const newer = newerPersistedToken(this.userId, this._token?.access_token)
    if (newer) {
      this._adopt(newer)
      return true
    }

    if (!this._token) return false
    const oauth = new OAuth2()
    oauth.token = this._token
    try {
      const newToken = await oauth.refreshToken()
      // 回写 user.json（源 update_user(user_id, token=new_token)）
      if (this.userId != null) {
        database.updateUser(this.userId, {
          accessToken: newToken.access_token,
          refreshToken: newToken.refresh_token,
        })
      }
      this._token = newToken
      this.headers.Authorization = `${newToken.token_type} ${newToken.access_token}`
      return true
    } catch {
      // ② 刷新失败：最常见的原因是**别的实例刚把 refresh_token 轮换掉**了
      //    （并发命令，或同一命令内先跑的那个实例）——库内此刻已有新凭据。
      //    取它兜底；确实取不到（凭据真被撤销/损坏）才认输，交由 _handleError
      //    抛 LXNSOAuthError 引导用户重新绑定。
      const fallback = newerPersistedToken(this.userId, this._token?.access_token)
      if (fallback) {
        this._adopt(fallback)
        return true
      }
      this._token = null
      return false
    }
  }

  async _handleError(resp) {
    if (resp.status === 200) return
    /**
     * 诊断信息：错误类不接受构造参数（文案表按 `instanceof` 映射，不能改），故把
     * **状态码、最终请求 URL、响应体里的 `message`** 挂到错误对象上
     * （`error.status` / `error.url` / `error.apiMessage`）。
     *
     * 为什么连 message 也要：落雪用**同一个端点家族**表达两类完全不同的语义（实测 2026-09-15）——
     *   `400 invalid friend code` → 存的好友码是错的（要引导重新 bind fc）
     *   `404 score not found`     → 好友码没问题，只是**没有这类成绩**（不该报「找不到资源」，更不该告警）
     * 只凭状态码无法区分，文案就会误导用户与运维。
     * ⚠️ 用 `resp.clone()` 读体：Response 的 body 只能消费一次，而 `_request` 之后还要 `resp.text()`。
     */
    const at = { status: resp.status, url: resp.url }
    try {
      const body = await resp.clone().json()
      if (body && typeof body.message === 'string') at.apiMessage = body.message
    } catch { /* 非 JSON / 空体：诊断字段缺省即可，不影响错误分类 */ }
    switch (resp.status) {
      case 400: throw Object.assign(new LXNSParamsError(), at)
      case 401: throw Object.assign(new LXNSOAuthError(), at)
      case 403: throw Object.assign(new LXNSPermissionDeniedError(), at)
      case 404: throw Object.assign(new LXNSNotFoundError(), at)
      case 429: throw Object.assign(new LXNSTooManyRequestsError(), at)
      default: throw Object.assign(new UnknownError(), at)
    }
  }

  /** 解包 APIResult {code, message, data} */
  async requestData(method, endpoint, kwargs = {}) {
    const data = await this._request(method, endpoint, kwargs)
    return data
  }

  /** 不解包（曲库等裸响应） */
  async requestBaseData(method, endpoint, kwargs = {}) {
    return await this._request(method, endpoint, kwargs)
  }
}

export class LxnsAPI {
  /**
   * @param {string|null} userId 库内用户键（401 刷新回写用）
   * @param {{access_token:string, refresh_token:string}|null} token OAuth 凭据；null = 未授权
   * @param {{friendCode?: number|null}} [opts] 好友码（`#mai bind fc` 落库的那份）。
   *   **无 OAuth 但有好友码**时各方法自动改走开发者 API（`/player/{fc}/…`）——
   *   可用范围见各方法注释（成绩全量那条路走不通，因为开发者 API 只给 SimpleScore）。
   */
  constructor(userId = null, token = null, { friendCode = null } = {}) {
    const fc = Number(friendCode)
    this._friendCode = Number.isInteger(fc) && fc > 0 ? fc : null
    this._oauthClient = token
      ? new LxnsClient({
          baseUrl: 'https://maimai.lxns.net/api/v0/user/maimai/player',
          headers: { Authorization: `Bearer ${token.access_token}` },
          userId,
          token,
        })
      : null

    this._devClient = new LxnsClient({
      baseUrl: 'https://maimai.lxns.net/api/v0/maimai',
      headers: { Authorization: Config.getUserCfg('config', 'lxnsDevToken') || '' },
      userId,
      token: null,
    })
  }

  /** 有 OAuth 凭据（本人授权）；否则只能走开发者 API + 好友码 */
  get hasOauth() {
    return this._oauthClient != null
  }

  /** 无 OAuth 时可用的好友码 */
  get friendCode() {
    return this._friendCode
  }

  /** 曲目数据（dev，含 notes） */
  async musicData() {
    return await this._devClient.requestBaseData('GET', '/song/list', { params: { notes: true } })
  }

  /** 别名列表（dev） */
  async musicAliasData() {
    return await this._devClient.requestBaseData('GET', '/alias/list')
  }

  /** 玩家信息（oauth / friend_code / qq 三形态；无 OAuth 时用绑定的好友码走开发者 API） */
  async player({ friendCode = null, qq = null } = {}) {
    if (friendCode != null) {
      return (await this._devClient.requestData('GET', `/player/${friendCode}`)).data
    }
    if (qq != null) {
      return (await this._devClient.requestData('GET', `/player/qq/${qq}`)).data
    }
    if (this._oauthClient) return (await this._oauthClient.requestData('GET', '')).data
    if (this._friendCode != null) {
      return (await this._devClient.requestData('GET', `/player/${this._friendCode}`)).data
    }
    throw new LXNSTokenError()
  }

  /** B50（OAuth `/bests`；无 OAuth 时走开发者 `/player/{fc}/bests`） */
  async best50() {
    if (this._oauthClient) return (await this._oauthClient.requestData('GET', '/bests')).data
    if (this._friendCode != null) {
      return (await this._devClient.requestData('GET', `/player/${this._friendCode}/bests`)).data
    }
    throw new LXNSTokenError()
  }

  /** AP50（dev，按好友码 —— 两条路子都是开发者 API，必带好友码） */
  async ap50(friendCode) {
    const fc = Number(friendCode) > 0 ? friendCode : this._friendCode
    if (!(Number(fc) > 0)) throw new LXNSTokenError()
    const result = await this._devClient.requestData('GET', `/player/${fc}/bests/ap`)
    return result.data
  }

  /**
   * 指定曲目全难度成绩
   *
   * ⚠️ 开发者侧走 `/player/{fc}/bests` **带 query 参数**（= 文档里「获取玩家缓存单曲所有谱面的成绩」
   * 那一节；它与 B50 是同一个 URL，靠参数区分），**不是**单数的 `/best`（那是「最佳成绩」单条）。
   */
  async songBests(songId, songType) {
    const params = { song_id: songId, song_type: songType }
    if (this._oauthClient) {
      return (await this._oauthClient.requestData('GET', '/bests', { params })).data ?? []
    }
    if (this._friendCode != null) {
      return (await this._devClient.requestData('GET', `/player/${this._friendCode}/bests`, { params })).data ?? []
    }
    throw new LXNSTokenError()
  }

  /**
   * 所有成绩（**仅 OAuth**）
   *
   * 开发者 API 有 `/player/{fc}/scores`，但返回的是 **SimpleScore**（只有 id/song_name/level/
   * level_index/fc/fs/rate/type，**没有 achievements / dx_score / dx_rating**）——
   * 拟合b50、随心配、完成表、理论列表全都靠达成率，喂不了。故只有好友码时明确报错，
   * 由上层引导用户 `#mai bind lxns`，而不是给一份缺字段的「假全量」。
   */
  async allBest() {
    if (!this._oauthClient) throw new LXNSAuthRequiredError()
    const result = await this._oauthClient.requestData('GET', '/scores')
    return result.data ?? []
  }
}
