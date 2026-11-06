/**
 * 水鱼查分器客户端（源 core/clients/divingfish/client.py 直译，设计 §7.1）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * 源 efa55a9（v3.1.5）：开发者 token 与 /dev/*、/query/plate 端点全面废弃——
 * 除 B50（POST /query/player 公开）外，一切成绩查询统一走 OAuth GET /player/records，
 * 筛选（song_id / level / ds / fc / fs / plate / version）由服务端完成。
 * 未 OAuth 绑定的用户此后只能用 b50（index.js 启动警告已提示）。
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

const logger = global.logger || console

/**
 * 成绩查询筛选条件（源 RecordsQueryRequest 字段；undefined 项不上送）
 * @typedef {object} RecordsQuery
 * @property {number} [song_id] 单曲 ID
 * @property {string} [level] 等级字面（"13" / "13+"）
 * @property {number} [level_index] 难度下标
 * @property {number} [ds] 定数
 * @property {string|string[]} [fc] 达标类型（"fc"/"fcp"/"ap"/"app"）
 * @property {string|string[]} [fs] 同步类型（"fs"/"fsp"/"fsd"/"fsdp"）
 * @property {string} [plate] 牌子名
 * @property {string[]} [version] 版本名列表
 */

export class DivingFishAPI extends ApiClient {
  constructor(qqid = null, username = null) {
    const cfg = Config.getUserCfg('config')
    const oauth = Boolean(cfg.dfClientId && cfg.dfClientSecret) && qqid != null && !username
    super({
      baseUrl: cfg.proberProxy ? `${PROXY_URL}/maimaidxprober` : BASE_URL,
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
      /**
       * 403 有两个来源，用户可见文案完全不同，按端点区分（源一律按 oauth 配置二分）：
       * ・`/query/*` 公开查询（不带任何凭据，见 queryUserB50）：目标用户没开「允许他人查询」→ 403。
       * ・`/player/*` 代用户端点：源 efa55a9 后**必然携带 Bearer**（成绩查询已 OAuth-only），
       *   403 即令牌没覆盖该权限（授权被撤销或范围不足）→ 确实该报未授权。
       */
      const url = String(resp.url || '')
      let detail = ''
      try { detail = (await resp.text()).slice(0, 120) } catch { /* 无响应体 */ }
      logger.warn(`[mai-plugin] 水鱼 403：${url || '(未知 URL)'}（oauth=${this.oauth}）${detail ? `｜${detail}` : ''}`)
      if (url.includes('/player/')) throw new DivingFishNotAuthorizedError()
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

  /**
   * 用户成绩查询（源 efa55a9 后的唯一成绩端点，OAuth-only GET /player/records）
   *
   * 旧版的三条路（qq 模式 GET /dev/player/records、POST /dev/player/record、
   * /query/plate）随开发者 token 一并废弃，故只保留 OAuth 通道；筛选走 params，
   * 服务端完成后只返回命中的成绩（含 records 包裹层，此处解包）。
   * @param {RecordsQuery|null} [query] 筛选条件；null/缺省 = 全量成绩
   * @returns {Promise<Array>} records 原始条目（Record 形状，含 level_label）
   */
  async queryUserRecords(query = null) {
    // undefined 项不上送（源 model_dump(exclude_none=True)）
    const params = query
      ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined))
      : undefined
    const result = await this._requestOAuth('GET', '/player/records', { params })
    return result?.records ?? []
  }

  /** 查分器 RA 排行（按 ra 降序） */
  async ratingRanking() {
    const result = await this._request('GET', '/rating_ranking')
    return result
      .map(u => ({ username: u.username, ra: u.ra }))
      .sort((a, b) => b.ra - a.ra)
  }
}
