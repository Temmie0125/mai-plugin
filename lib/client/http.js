/**
 * HTTP 基建（源 core/clients/http.py ApiClient → fetch 直译，设计 §七）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * - AbortController 超时（默认 60s）
 * - 幂等 GET 网络错误重试 ×1（退避 300ms）
 * - 401 → _onUnauthorized() 钩子（LXNS 401 自动刷新重试一次）
 */
import { ApiError } from './errors.js'

const UA = 'mai-plugin/TRSS-Yunzai (port of nonebot-plugin-maimaidx)'

export class ApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {Record<string, string>} [opts.headers]
   * @param {number} [opts.timeout] 毫秒
   */
  constructor({ baseUrl, headers = {}, timeout = 60000 }) {
    this.baseUrl = baseUrl
    this.headers = headers
    this.timeout = timeout
  }

  async _fetch(method, endpoint, kwargs = {}) {
    let url = this.baseUrl + endpoint
    if (kwargs.params) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(kwargs.params)) qs.append(k, String(v))
      url += (url.includes('?') ? '&' : '?') + qs.toString()
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    /**
     * 外部 signal（长连接用：SSE 要能主动断开，而超时用的 controller 只覆盖「连接+响应头」，
     * 拿到响应头后就 clearTimeout 了、之后再也掐不断）。
     * ⚠️ 监听器**刻意不在 finally 里摘除**：`_fetch` 返回 Response 后调用方还要读 body，
     * 而 `finally` 在响应头到达时就已执行——摘了就等于外部 signal 之后失效。
     * 每个连接一个 signal，随连接对象一起回收，不会累积。
     */
    const external = kwargs.signal
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const init = {
        method,
        headers: { 'User-Agent': UA, ...(this.headers || {}), ...(kwargs.headers || {}) },
        signal: controller.signal,
      }
      if (kwargs.json !== undefined) {
        init.body = JSON.stringify(kwargs.json)
        init.headers['Content-Type'] = 'application/json'
      } else if (kwargs.form !== undefined) {
        // OAuth 端点均为 form-urlencoded 体（水鱼 device_authorization/oauth/token 等）
        const qs = new URLSearchParams()
        for (const [k, v] of Object.entries(kwargs.form)) qs.append(k, String(v))
        init.body = qs.toString()
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
      return await fetch(url, init)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 请求并返回解析后的 JSON（源 _request：401 → 钩子刷新 → 单次重试）
   * @returns {Promise<any>}
   */
  async _request(method, endpoint, kwargs = {}) {
    const run = () => this._fetch(method, endpoint, kwargs)

    let resp
    try {
      resp = await run()
    } catch (error) {
      if (method === 'GET') {
        await new Promise(r => setTimeout(r, 300))
        resp = await run()
      } else {
        throw new ApiError(`网络请求失败：${error.message}`)
      }
    }

    if (resp.status === 401) {
      const handled = await this._onUnauthorized()
      if (handled) resp = await run()
    }

    await this._handleError(resp)
    const text = await resp.text()
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw new ApiError(`响应不是有效 JSON：${text.slice(0, 120)}`)
    }
  }

  async _onUnauthorized() {
    return false
  }

  /** 非 2xx 时抛对应错误（子类实现可为 async） */
  async _handleError(/** resp */) {
    throw new Error('not implemented')
  }
}

/** QQ 头像直链（模板 <img> 直接引用，源 qqlogo 的 URL 形态） */
export function qqLogoUrl(qqid) {
  return `https://q1.qlogo.cn/g?b=qq&nk=${qqid}&s=100`
}

/** 柚子在线素材直链（源 online_assets 的 URL 形态，plate/icon 收藏品切图） */
export function onlineAssetUrl(endpoint) {
  return `https://www.yuzuchan.moe/assets/maimaidx${endpoint}`
}
