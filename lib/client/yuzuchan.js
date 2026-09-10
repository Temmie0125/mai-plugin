/**
 * 柚子客户端（源 core/clients/yuzuchan/client.py 直译，设计 §7.1）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * 读接口：曲库别名 / 牌子数据 / 按名查投票态（什么歌反查用）；
 * 写接口（P3c）：别名申请 / 同意别名 / 进行中的投票列表。
 */
import { randomUUID } from 'node:crypto'
import Config from '../config.js'
import { ApiClient } from './http.js'
import { RequestError, ServerError, UnknownError } from './errors.js'

/**
 * 进程级会话标识（源 `constants.py:7` `UUID = uuid.uuid1()`，进程内常量、所有请求复用同一个）
 * Node 无内置 uuid v1（时间戳 + MAC），改用 randomUUID（v4）。服务端只把它当会话标识用，
 * 语义等价 —— 登记为刻意偏离（文档 §7.2）。
 */
const WS_UUID = randomUUID()

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

  /**
   * 事件流（SSE）。**不走 `_request`**——那条路会 `resp.text()` 缓冲到 EOF，
   * 而长连接永远没有 EOF。此处返回**原始 Response**，由调用方逐行读 body。
   * @param {{lastEventId?: string|null, signal?: AbortSignal}} [opts]
   */
  async openEventStream({ lastEventId = null, signal } = {}) {
    return await this._fetch('GET', '/events', {
      headers: {
        Accept: 'text/event-stream',
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      signal,
    })
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

  /** 按 ID 查别名（源 `get_aliases(song_id=...)`；message 响应原样返回由调用方分支） */
  async getAliasesBySongId(songId) {
    return await this._requestData(
      'GET', this.aliasesEndpoint + '/aliases',
      { acceptMessage: true }, { params: { song_id: songId } }
    )
  }

  /**
   * 别名申请（源 `post_alias`，设计 §7.2）
   * body 键名照搬源；`song_id` 源侧就是**字符串**（`mai_alias.py` 传的 `match.group(1)`），此处不转数字
   * @returns {Promise<object>} 服务端 MessageResult（`{message}`）；4xx 时同样返回响应体，由调用方转发 message
   */
  async postAlias(songId, aliasName, userId, groupId) {
    return await this._requestData(
      'POST', this.aliasesEndpoint + '/apply',
      { acceptMessage: true },
      {
        json: {
          song_id: songId,
          apply_alias: aliasName,
          apply_uid: userId,
          group_id: groupId,
          ws_uuid: WS_UUID,
        },
      }
    )
  }

  /** 同意别名（源 `post_agree_user`）：tag 仅由调用方 toUpperCase 后原样回传，源不做校验、空串也发 */
  async postAgreeUser(tag, userId) {
    return await this._requestData(
      'POST', this.aliasesEndpoint + '/votes',
      { acceptMessage: true },
      { json: { tag, agree_user: userId } }
    )
  }

  /** 正在进行的别名投票（源 `get_status`）：源此处**不吞** 4xx，4xx 直接抛 */
  async getStatus() {
    return await this._requestData(
      'GET', this.aliasesEndpoint + '/votes',
      {}, { params: { status: 'ongoing' } }
    )
  }
}
