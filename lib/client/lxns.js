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

class LxnsClient extends ApiClient {
  constructor({ baseUrl, headers, userId, token = null }) {
    super({ baseUrl, headers, timeout: 180000 })
    this.userId = userId
    this._token = token
  }

  async _onUnauthorized() {
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
      this._token = null
      return false
    }
  }

  async _handleError(resp) {
    switch (resp.status) {
      case 200: return
      case 400: throw new LXNSParamsError()
      case 401: throw new LXNSOAuthError()
      case 403: throw new LXNSPermissionDeniedError()
      case 404: throw new LXNSNotFoundError()
      case 429: throw new LXNSTooManyRequestsError()
      default: throw new UnknownError()
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
  constructor(userId = null, token = null) {
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

  /** 曲目数据（dev，含 notes） */
  async musicData() {
    return await this._devClient.requestBaseData('GET', '/song/list', { params: { notes: true } })
  }

  /** 别名列表（dev） */
  async musicAliasData() {
    return await this._devClient.requestBaseData('GET', '/alias/list')
  }

  /** 玩家信息（oauth / friend_code / qq 三形态） */
  async player({ friendCode = null, qq = null } = {}) {
    let result
    if (friendCode != null) {
      result = await this._devClient.requestData('GET', `/player/${friendCode}`)
    } else if (qq != null) {
      result = await this._devClient.requestData('GET', `/player/qq/${qq}`)
    } else {
      result = await this._oauthClient.requestData('GET', '')
    }
    return result.data
  }

  /** B50（oauth） */
  async best50() {
    const result = await this._oauthClient.requestData('GET', '/bests')
    return result.data
  }

  /** AP50（dev，按好友码） */
  async ap50(friendCode) {
    const result = await this._devClient.requestData('GET', `/player/${friendCode}/bests/ap`)
    return result.data
  }

  /** 指定曲目全难度成绩（oauth） */
  async songBests(songId, songType) {
    const result = await this._oauthClient.requestData('GET', '/bests', {
      params: { song_id: songId, song_type: songType },
    })
    return result.data ?? []
  }

  /** 所有成绩（oauth） */
  async allBest() {
    const result = await this._oauthClient.requestData('GET', '/scores')
    return result.data ?? []
  }
}
