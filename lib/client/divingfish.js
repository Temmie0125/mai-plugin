/**
 * 水鱼查分器客户端（源 core/clients/divingfish/client.py 直译，设计 §7.1）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * P1 范围：公开查询（qq / username）+ 曲库数据；OAuth 代查（P2 bind 接入后启用）。
 */
import Config from '../config.js'
import { ApiClient } from './http.js'
import { getAccessToken } from './divingfishOauth.js'
import {
  DivingFishNotAuthorizedError,
  DivingFishTokenDisableError,
  DivingFishTokenError,
  DivingFishTokenNotFoundError,
  DivingFishTooManyRequestsError,
  DivingFishUserDisabledQueryError,
  DivingFishUserNotFoundError,
  UnknownError,
  UserNotExistsError,
} from './errors.js'

const PROXY_URL = 'https://proxy.yuzuchan.site'
const BASE_URL = 'https://maimai.diving-fish.com/api/maimaidxprober'

export class DivingFishAPI extends ApiClient {
  constructor(qqid = null, username = null) {
    const cfg = Config.getUserCfg('config')
    const oauth = Boolean(cfg.dfClientId && cfg.dfClientSecret) && qqid != null && !username
    super({
      baseUrl: cfg.proberProxy ? `${PROXY_URL}/maimaidxprober` : BASE_URL,
      headers: oauth || !cfg.dfDeveloperToken ? {} : { 'developer-token': cfg.dfDeveloperToken },
      timeout: 180000,
    })
    this.oauth = oauth
    this.qqid = qqid
    /** 查询载体：qq 或 username（互斥，源构造器语义） */
    this.json = {}
    if (qqid) this.json.qq = qqid
    if (username) {
      this.json.username = username
      delete this.json.qq
    }
  }

  /**
   * 代用户请求（源 client.py _request_oauth）：每次调用现取 5 分钟缓存令牌注入
   * Bearer——构造期不注入，缓存会过期失效；查询成功后的头部残留与源同款（实例级粘滞）
   */
  async _requestOAuth(method, endpoint, kwargs = {}) {
    const token = await getAccessToken(this.qqid)
    kwargs.headers = { ...(kwargs.headers || {}), Authorization: `Bearer ${token}` }
    return await this._request(method, endpoint, kwargs)
  }

  /** 401 钩子（http.js 自动单次重试）：oauth 分支丢弃缓存强制换新，非 oauth 放行 _handleError */
  async _onUnauthorized() {
    if (!this.oauth) return false
    const token = await getAccessToken(this.qqid, { refresh: true })
    this.headers = { ...(this.headers || {}), Authorization: `Bearer ${token}` }
    return true
  }

  async _handleError(resp) {
    if (resp.status === 200) return
    if (resp.status === 400) {
      // 400 错误体在 message/msg 字段，源 _handle_400 文案分流
      let error = {}
      try { error = await resp.json() } catch { /* 保持空体 */ }
      this._handle400(error)
      return
    }
    if (resp.status === 401) throw new DivingFishTokenError()
    if (resp.status === 403) {
      if (this.oauth) throw new DivingFishNotAuthorizedError()
      throw new DivingFishUserDisabledQueryError()
    }
    if (resp.status === 429) throw new DivingFishTooManyRequestsError()
    throw new UnknownError()
  }

  _handle400(error) {
    const msg = error.message || error.msg
    if (msg != null) {
      if (msg === 'no such user') throw new DivingFishUserNotFoundError()
      if (msg === 'user not exists') throw new UserNotExistsError()
      if (msg === '开发者token有误') throw new DivingFishTokenError()
      if (msg === '开发者token被禁用') throw new DivingFishTokenDisableError()
      if (msg === '请先联系水鱼申请开发者token') throw new DivingFishTokenNotFoundError()
    }
    throw new UnknownError()
  }

  /** 曲目数据 */
  async musicData() {
    return await this._request('GET', '/music_data')
  }

  /** 单曲全服统计 */
  async chartStats() {
    return await this._request('GET', '/chart_stats')
  }

  /** 玩家 B50（公开查询：qq 或 username） */
  async queryUserB50() {
    this.json.b50 = true
    return await this._request('POST', '/query/player', { json: this.json })
  }

  /** 用户指定曲目成绩：oauth → /player/record（独立 payload，不携带 qq）；qq 模式 → dev 端点 */
  async queryUserRecord(songId) {
    const ids = Array.isArray(songId) ? songId : [songId]
    let result
    if (this.oauth) {
      // ⚠️ 独立 payload 只含 music_id——oauth 分支继续用共享 this.json 会把 qq 泄漏进 /player/record
      result = await this._requestOAuth('POST', '/player/record', { json: { music_id: ids } })
    } else {
      this.json.music_id = ids
      result = await this._request('POST', '/dev/player/record', { json: this.json })
    }
    if (result && Object.keys(result).length === 0) return []
    const list = []
    for (const v of Object.values(result)) {
      for (const d of v) list.push(d)
    }
    return list
  }

  /** 查分器 RA 排行（按 ra 降序） */
  async ratingRanking() {
    const result = await this._request('GET', '/rating_ranking')
    return result
      .map(u => ({ username: u.username, ra: u.ra }))
      .sort((a, b) => b.ra - a.ra)
  }
}
