/**
 * 柚子客户端（源 core/clients/yuzuchan/client.py 直译，设计 §7.1）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * P1 范围：曲库别名 / 牌子数据 / 按名查投票态（什么歌反查用）；
 * 别名申请/投票等写接口 P3 接入。
 */
import Config from '../config.js'
import { ApiClient } from './http.js'
import { RequestError, ServerError, UnknownError } from './errors.js'

export function yuzuBaseUrl() {
  const domain = Config.getUserCfg('config', 'aliasProxy') ? 'cn' : 'moe'
  return `https://www.yuzuchan.${domain}/api/v2`
}

export class YuzuChaNAPI extends ApiClient {
  constructor() {
    super({ baseUrl: yuzuBaseUrl() })
    this.musicEndpoint = '/maimaidx/music'
    this.aliasesEndpoint = '/aliases/maimaidx'
  }

  async _handleError(resp) {
    if (resp.status >= 200 && resp.status < 300) return
    if (resp.status >= 400 && resp.status < 500) {
      // 源 RequestError 携带响应体供 accept_message 分支消化
      let data = {}
      try { data = await resp.json() } catch { /* 空体 */ }
      throw new RequestError(data)
    }
    if (resp.status >= 500 && resp.status < 600) throw new ServerError()
    throw new UnknownError()
  }

  /**
   * @param {string} method
   * @param {string} endpoint
   * @param {{acceptMessage?: boolean}} opts accept_message：4xx 响应体原样返回（源语义）
   */
  async _requestData(method, endpoint, opts = {}, kwargs = {}) {
    try {
      return await this._request(method, endpoint, kwargs)
    } catch (error) {
      if (opts.acceptMessage && error instanceof RequestError) return error.data
      throw error
    }
  }

  /** 版本牌子完成需求 */
  async getPlateJson() {
    return await this._requestData('GET', this.musicEndpoint + '/get_plate')
  }

  /** 全量别名 */
  async getAliases() {
    return await this._requestData('GET', this.aliasesEndpoint + '/aliases')
  }

  /** 按名/ID 查别名（message 响应原样返回由调用方分支） */
  async getAliasesByName(name) {
    return await this._requestData(
      'GET', this.aliasesEndpoint + '/aliases',
      { acceptMessage: true }, { params: { name } }
    )
  }

  /** 按名查曲目/投票状态（什么歌反查链） */
  async getSongs(name) {
    return await this._requestData(
      'GET', this.aliasesEndpoint + '/songs',
      { acceptMessage: true }, { params: { name } }
    )
  }
}
